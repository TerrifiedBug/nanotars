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
import { getAgentGroupByFolder } from '../db/agent-groups.js';
import { logger } from '../logger.js';
import {
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
 * Register the `install_packages` approval handler on host startup.
 *
 * 5C-03 wires only the `render` half — the resulting pending_approvals row
 * has a renderable card that the click-router (Phase 4D D7) can deliver.
 * `applyDecision` (the mutate-config + rebuild + restart half) is added in
 * 5C-04, where it takes injected dependencies (buildImage, restartGroup,
 * notifyAfter) so the registration stays test-friendly.
 */
export function registerInstallPackagesHandler(): void {
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
    // applyDecision wired in 5C-04 (mutate config + rebuild + restart).
  });
}
