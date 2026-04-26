/**
 * Phase 5C — host-side handler for the `install_packages` IPC task emitted
 * by the container's `install_packages` MCP tool.
 *
 * Flow (5C-03 — request side):
 *   1. Resolve the calling agent group from `groupFolder`.
 *   2. Re-validate the request (apt/npm regex, max-packages cap) as
 *      defense-in-depth — the container-side validator is not a trust
 *      boundary against compromised agent containers.
 *   3. Call `requestApproval({ action: 'install_packages', ... })` (Phase 4C
 *      primitive) which writes a `pending_approvals` row, picks an approver
 *      via the C3 hierarchy, and returns the rendered card.
 *   4. The card is delivered via the host's `setApprovalFallbackSender`
 *      adapter wired in `src/index.ts`.
 *   5. On admin click, the click-router (Phase 4D D7) dispatches to
 *      `applyDecision` on the registered handler — wired in 5C-04.
 *
 * Validation invariants:
 *   - APT_RE / NPM_RE / MAX_PACKAGES match the container-side validator.
 *     Both sides MUST stay in sync; consider extracting to a shared module
 *     if they diverge.
 *   - `groupFolder` → `agentGroupId` resolution is the only privileged
 *     operation here. There is no sender-userid threading on this IPC path
 *     (same gap as `lifecycle-handlers.ts` / `create-agent.ts`); approval
 *     itself enforces admin policy at click-auth time (Phase 4D D7).
 *
 * Notes:
 *   - notifyAgent is a logger-warn stub today; 5C-05 wires real chat
 *     injection so the agent sees its own validation failures.
 */
import {
  getAgentGroupById,
  getAgentGroupByFolder,
  updateAgentGroupContainerConfig,
} from '../db/agent-groups.js';
import { logger } from '../logger.js';
import {
  getPendingApproval,
  notifyAgent,
  registerApprovalHandler,
  requestApproval,
} from './approval-primitive.js';

/** apt package names: lowercase alphanumeric, may contain `.`, `_`, `+`, `-`. */
export const APT_PACKAGE_RE = /^[a-z0-9][a-z0-9._+-]*$/;
/** npm package names: optional `@scope/`, then lowercase alphanumeric with `.`, `_`, `-`. */
export const NPM_PACKAGE_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const MAX_PACKAGES = 20;

export interface InstallPackagesRequestTask {
  apt: string[];
  npm: string[];
  reason: string;
  groupFolder: string;
}

/**
 * Process an `install_packages` IPC task: validate + queue an approval card.
 *
 * Returns the resulting `approvalId` on success; undefined when the request
 * was dropped (unknown group, validation error, or no approver pool).
 */
export async function handleInstallPackagesRequest(
  task: InstallPackagesRequestTask,
  originatingChannel: string,
): Promise<string | undefined> {
  const ag = getAgentGroupByFolder(task.groupFolder);
  if (!ag) {
    logger.warn(
      { folder: task.groupFolder },
      'install_packages dropped: agent group not found',
    );
    return undefined;
  }

  const apt = task.apt ?? [];
  const npm = task.npm ?? [];

  if (apt.length === 0 && npm.length === 0) {
    notifyAgent(ag.id, 'install_packages failed: at least one apt or npm package required.');
    return undefined;
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    notifyAgent(
      ag.id,
      `install_packages failed: too many packages (max ${MAX_PACKAGES}; got ${apt.length + npm.length}).`,
    );
    return undefined;
  }
  const badApt = apt.find((p) => !APT_PACKAGE_RE.test(p));
  if (badApt !== undefined) {
    notifyAgent(ag.id, `install_packages failed: invalid apt package name "${badApt}".`);
    return undefined;
  }
  const badNpm = npm.find((p) => !NPM_PACKAGE_RE.test(p));
  if (badNpm !== undefined) {
    notifyAgent(ag.id, `install_packages failed: invalid npm package name "${badNpm}".`);
    return undefined;
  }

  const result = await requestApproval({
    action: 'install_packages',
    agentGroupId: ag.id,
    payload: { apt, npm, reason: task.reason },
    originatingChannel,
  });

  logger.info(
    {
      approvalId: result.approvalId,
      agentGroupId: ag.id,
      apt,
      npm,
      hasApprover: result.approvers.length > 0,
    },
    'install_packages approval queued',
  );
  return result.approvalId;
}

/**
 * Dependencies the `applyDecision` half needs at runtime. Injected at host
 * startup so the production wiring uses real `buildAgentGroupImage` /
 * `groupQueue.restartGroup` while tests pin them to mocks. Each dep is
 * separately exposed so 5C-04 tests can assert call counts without owning
 * the whole registration shape.
 */
export interface InstallPackagesDeps {
  /** Rebuild the per-group image. Resolves to the new imageTag. */
  buildImage: (agentGroupId: string) => Promise<string>;
  /** Stop the active container for `folder` so the next inbound respawns. */
  restartGroup: (folder: string, reason: string) => Promise<void>;
  /**
   * Send a system message to the agent some time after the rebuild completes.
   * Defers in real wiring (default 5s) so the new container is up before the
   * "verify" prompt arrives. Tests typically pass a fire-immediately stub.
   */
  notifyAfter: (agentGroupId: string, text: string, deferMs: number) => void;
}

/**
 * Register the `install_packages` approval handler on host startup.
 *
 * Pass `deps` to wire the full apply path (mutate config → rebuild image →
 * restart container → notify agent). Omit `deps` for a render-only registration
 * (used in 5C-03 unit tests and for environments without the host runtime).
 *
 * Idempotent: `registerApprovalHandler` overwrites any previous registration
 * for the same action — safe to call multiple times in tests. The applyDecision
 * itself is also idempotent on repeated approval click (no-op once the imageTag
 * is set + the agent is notified, because the click-router only fires once).
 */
export function registerInstallPackagesHandler(
  deps?: InstallPackagesDeps,
): void {
  registerApprovalHandler('install_packages', {
    render({ payload }) {
      const apt = (payload.apt as string[] | undefined) ?? [];
      const npm = (payload.npm as string[] | undefined) ?? [];
      const reason = (payload.reason as string | undefined) ?? '';
      const list = [
        ...apt.map((p) => `apt: ${p}`),
        ...npm.map((p) => `npm: ${p}`),
      ].join(', ');
      const body = list
        ? `Agent wants to install + rebuild container:\n${list}${reason ? `\nReason: ${reason}` : ''}`
        : 'Agent wants to install packages (none specified).';
      return {
        title: 'Install Packages Request',
        body,
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      };
    },

    async applyDecision({ approvalId, payload, decision }) {
      const apt = (payload.apt as string[] | undefined) ?? [];
      const npm = (payload.npm as string[] | undefined) ?? [];

      // Lookup the persisted approval row to recover agent_group_id (the
      // 4C primitive stored it on insert, so we have a direct path back to
      // the requesting group without re-deriving from the originator).
      const approval = getPendingApproval(approvalId);
      const agentGroupId =
        typeof approval?.agent_group_id === 'string'
          ? approval.agent_group_id
          : null;
      if (!agentGroupId) {
        logger.warn(
          { approvalId },
          'install_packages applyDecision: approval row missing agent_group_id; nothing to mutate',
        );
        return;
      }
      const ag = getAgentGroupById(agentGroupId);
      if (!ag) {
        logger.warn(
          { approvalId, agentGroupId },
          'install_packages applyDecision: agent group not found',
        );
        return;
      }

      if (decision === 'rejected' || decision === 'expired') {
        const verb = decision === 'expired' ? 'expired' : 'rejected';
        notifyAgent(
          agentGroupId,
          `install_packages ${verb}. ` +
            `Packages NOT installed: ${[
              ...apt.map((p) => 'apt:' + p),
              ...npm.map((p) => 'npm:' + p),
            ].join(', ')}.`,
        );
        return;
      }

      if (decision !== 'approved') {
        logger.warn(
          { approvalId, decision },
          'install_packages applyDecision: unknown decision value; skipping',
        );
        return;
      }

      if (!deps) {
        logger.warn(
          { approvalId, agentGroupId },
          'install_packages approved but deps not wired — config unchanged. ' +
            'This is the render-only registration used in tests; pass deps at host startup.',
        );
        return;
      }

      // Merge new packages into existing container_config.packages. We
      // append, not replace — multiple sequential approvals stack their
      // package sets. Duplicate names dedupe to keep the layered Dockerfile
      // RUN step minimal.
      updateAgentGroupContainerConfig(agentGroupId, (cfg) => {
        const cur = cfg.packages ?? { apt: [], npm: [] };
        return {
          ...cfg,
          packages: {
            apt: Array.from(new Set([...cur.apt, ...apt])),
            npm: Array.from(new Set([...cur.npm, ...npm])),
          },
        };
      });

      try {
        await deps.buildImage(agentGroupId);
        await deps.restartGroup(ag.folder, 'install_packages applied');
        const list = [
          ...apt.map((p) => 'apt:' + p),
          ...npm.map((p) => 'npm:' + p),
        ].join(', ');
        // Defer the "verify" prompt so the freshly-rebuilt container has
        // time to start before the agent gets the message. The 5-second
        // default matches the spec's §5C bullet 8.
        deps.notifyAfter(
          agentGroupId,
          `Packages installed (${list}). Verify they work and report back.`,
          5000,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notifyAgent(
          agentGroupId,
          `Build failed: ${msg}. An admin will need to retry; ` +
            `container_config.packages was already updated, so /rebuild-image may suffice.`,
        );
        logger.error(
          { err, agentGroupId, approvalId },
          'install_packages applyDecision: build/restart failed',
        );
      }
    },
  });
}
