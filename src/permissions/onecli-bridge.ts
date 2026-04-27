/**
 * OneCLI manual-approval bridge.
 *
 * When the OneCLI gateway intercepts a credentialed request that needs human
 * approval, it holds the HTTP connection open and fires the callback we
 * register via `OneCLI.configureManualApproval`. This bridge:
 *
 *   1. Receives the OneCLI ApprovalRequest.
 *   2. Resolves the originating agent group from `request.agent.externalId`
 *      (container-runner sets this to the agent group's folder; map it back
 *      to an agent_groups row via `getAgentGroupByFolder`). Falls back to
 *      `agent_group_id = null` if no match.
 *   3. Calls `pickApprover(agentGroupId)` to enumerate eligible admins/owners.
 *   4. Calls `pickApprovalDelivery(approvers, '')` to choose a DM target.
 *   5. Calls `requestApproval` (action='onecli_credential') to persist a
 *      `pending_approvals` row. The C2 primitive embeds the picked approver
 *      into payload._picked_approver_user_id automatically; we add the
 *      OneCLI-specific bits via the `payload` arg.
 *   6. Awaits a Promise stored in an in-memory `pending` map. The Promise
 *      resolves when:
 *         a) The C4 click-auth handler fires `applyDecision` on this action,
 *            which we register at startup. applyDecision looks up the
 *            approval id in `pending` and resolves the Promise.
 *         b) An expiry timer fires just before the gateway's TTL. If the
 *            click-auth path hasn't already won, the timer auto-denies.
 *   7. Returns 'approve' or 'deny' to OneCLI.
 *
 * Auto-deny on no-approver / no-DM: if no eligible approver exists, or no
 * approver has a reachable DM, we return 'deny' immediately rather than
 * holding the gateway connection open until TTL.
 *
 * Card delivery to the chosen `target.messagingGroup` is TODO(C7 + Phase 4D
 * D6) — currently the row is persisted but the human only sees a card if
 * delivery is wired by another path. The bridge still works: a click on a
 * card delivered via that other path will resolve the Promise via the
 * registered applyDecision callback.
 */
import { OneCLI, type ApprovalRequest, type ManualApprovalHandle } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from '../config.js';
import { getAgentGroupByFolder } from '../db/agent-groups.js';
import { logger } from '../logger.js';
import {
  registerApprovalHandler,
  requestApproval,
  type ApprovalHandler,
} from './approval-primitive.js';
import { pickApprovalDelivery, pickApprover } from './approval-routing.js';
import { deliverApprovalCard } from './approval-delivery.js';

/** Action key for `pending_approvals.action` and the handler registry. */
export const ONECLI_ACTION = 'onecli_credential';

/** SDK's return type — note the OneCLI SDK uses 'deny' (not 'reject'). */
type Decision = 'approve' | 'deny';

interface PendingState {
  resolve: (decision: Decision) => void;
  timer: NodeJS.Timeout;
}

/** approvalId → in-memory waiter. Survives only as long as the host process. */
const pending = new Map<string, PendingState>();

let handle: ManualApprovalHandle | null = null;
let onecli: OneCLI | null = null;

/**
 * Start the bridge. Idempotent — calling twice is a no-op.
 *
 * Registers an ApprovalHandler for ONECLI_ACTION on the C2 primitive so
 * click-auth's applyDecision callback can resolve the in-memory Promise.
 * Also instantiates an OneCLI client and calls `configureManualApproval`
 * to start the long-poll worker.
 *
 * Phase 4C C6 — depends on Phase 3 OneCLI gateway and Phase 4B pickApprover.
 */
export function startOneCLIBridge(): void {
  if (handle) return;
  onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

  // Register the OneCLI action handler with C2's primitive. render() is
  // unused for now (card delivery is TODO C7), but is required by the
  // ApprovalHandler interface so the row's `title` + `options_json` get
  // populated for any future delivery path.
  const handlerImpl: ApprovalHandler = {
    render: ({ payload }) => {
      const lines = [
        'Credential access request',
        `Agent: ${(payload.agent_name as string | undefined) ?? '(unknown)'}`,
        '```',
        `${payload.method as string} ${payload.host as string}${payload.path as string}`,
        '```',
      ];
      if (payload.bodyPreview) {
        lines.push('Body:', '```', String(payload.bodyPreview), '```');
      }
      return {
        title: 'Credentials Request',
        body: lines.join('\n'),
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      };
    },
    applyDecision: ({ approvalId, decision }) => {
      const state = pending.get(approvalId);
      if (!state) return;
      pending.delete(approvalId);
      clearTimeout(state.timer);
      // C4's applyDecision contract uses 'approved' | 'rejected' | 'expired';
      // OneCLI's return type is 'approve' | 'deny'. Map across the seam.
      state.resolve(decision === 'approved' ? 'approve' : 'deny');
    },
  };
  registerApprovalHandler(ONECLI_ACTION, handlerImpl);

  handle = onecli.configureManualApproval(async (request: ApprovalRequest): Promise<Decision> => {
    try {
      return await handleRequest(request);
    } catch (err) {
      logger.error({ id: request.id, err }, 'OneCLI approval handler errored');
      return 'deny';
    }
  });

  logger.info('OneCLI manual-approval bridge started');
}

/**
 * Stop the bridge. Used in tests and on graceful shutdown. Cancels all
 * pending timers and clears the in-memory map. Pending Promises are NOT
 * resolved here (they belong to in-flight gateway requests that will
 * receive their own deny via the SDK's stop semantics).
 */
export function stopOneCLIBridge(): void {
  handle?.stop();
  handle = null;
  for (const state of pending.values()) clearTimeout(state.timer);
  pending.clear();
  onecli = null;
}

/**
 * Internal request handler. Exported only for tests; use `startOneCLIBridge`
 * for the production path.
 */
export async function handleRequest(request: ApprovalRequest): Promise<Decision> {
  // request.agent.externalId is set by container-runner.ts at agent
  // registration time. v1's container-runner (and the OneCLI agent
  // record it creates via ensureAgent) keys on the agent group's folder
  // string, so map back via getAgentGroupByFolder. Null externalId is
  // legal — treat as unscoped.
  const originGroup = request.agent.externalId
    ? getAgentGroupByFolder(request.agent.externalId)
    : undefined;
  const agentGroupId = originGroup?.id ?? null;

  const approvers = pickApprover(agentGroupId);
  if (approvers.length === 0) {
    logger.warn(
      { id: request.id, host: request.host, agent: request.agent.externalId },
      'OneCLI approval auto-denied: no eligible approver',
    );
    return 'deny';
  }

  // No origin channel preference — OneCLI requests don't carry one. First
  // approver with a reachable DM in the cache wins.
  const target = await pickApprovalDelivery(approvers, '');
  if (!target) {
    logger.warn(
      { id: request.id, approvers: approvers.map((a) => a.id) },
      'OneCLI approval auto-denied: no DM channel for any approver',
    );
    return 'deny';
  }

  // Persist via the C2 primitive. requestApproval re-runs pickApprover +
  // pickApprovalDelivery internally and embeds _picked_approver_user_id
  // into the payload — so the approver we pick here may differ from the
  // one the primitive picks, but that's fine: both routes use the same
  // hierarchy, the DB row carries the primitive's choice, and we already
  // confirmed at least one approver is reachable.
  const result = await requestApproval({
    action: ONECLI_ACTION,
    agentGroupId,
    payload: {
      onecli_request_id: request.id,
      method: request.method,
      host: request.host,
      path: request.path,
      bodyPreview: request.bodyPreview,
      agent_name: request.agent.name,
      agent_external_id: request.agent.externalId,
    },
    request_id: request.id,
    expires_at: request.expiresAt,
    skipDelivery: true,
  });

  // Phase 4D D6: deliver the credentialed-action card via the
  // approval-delivery dispatcher. Best-effort — if no per-channel
  // adapter is registered, the plain-text fallback still surfaces the
  // request to the approver. The result.card carries the rendered
  // title/body/options from the registered handler (handlerImpl.render
  // above).
  if (result.card) {
    void deliverApprovalCard({
      approval_id: result.approvalId,
      channel_type: target.messagingGroup.channel_type,
      platform_id: target.messagingGroup.platform_id,
      title: result.card.title,
      body: result.card.body,
      options: result.card.options,
    }).catch((err) =>
      logger.warn({ err, approvalId: result.approvalId }, 'onecli-bridge: deliverApprovalCard failed'),
    );
  }
  logger.info(
    {
      approvalId: result.approvalId,
      target: target.userId,
      onecliRequestId: request.id,
    },
    'OneCLI approval card persisted + delivery dispatched',
  );

  // Expiry timer fires just before the gateway's own TTL so our deny
  // lands in time to be recorded; if the gateway's HTTP side has already
  // closed, the SDK swallows the late return.
  const expiresAtMs = new Date(request.expiresAt).getTime();
  const timeoutMs = Math.max(1000, expiresAtMs - Date.now() - 1000);

  return new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(result.approvalId)) return;
      pending.delete(result.approvalId);
      logger.info({ approvalId: result.approvalId }, 'OneCLI approval expired (no response)');
      resolve('deny');
    }, timeoutMs);
    pending.set(result.approvalId, { resolve, timer });
  });
}

/**
 * Test-only: inspect the in-memory waiter map. Exported so tests can
 * assert state without poking module internals via reflection.
 */
export function _getPendingForTest(): Map<string, PendingState> {
  return pending;
}
