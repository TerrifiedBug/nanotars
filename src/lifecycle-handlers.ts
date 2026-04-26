/**
 * Phase 5D — host-side handlers for `emergency_stop` and `resume_processing`
 * IPC tasks emitted by the container-side MCP tools.
 *
 * These handlers operate the soft-pause layer: they flip the process-level
 * `pausedGate` flag so future container wakes are queued. They do NOT call
 * `GroupQueue.emergencyStop()` (kill-now) — that's a separate, preserved
 * path on the existing IPC `emergency_stop` case in `tasks.ts`. Per the
 * spec these are two layers, two concerns.
 *
 * Authorization:
 *   The plan calls for re-validating that the calling user is an admin of
 *   the requesting agent group. v1-archive's IPC layer does not yet thread
 *   a sender userId through every payload (see the documented gap in
 *   `src/ipc/auth.ts:isAuthorizedAdminOp` — Phase 4D was scoped to land
 *   userId threading and stopped before completing it).
 *
 *   Until the IPC layer carries a verified sender, these handlers fall back
 *   to the same `isMain` heuristic as `isAuthorizedAdminOp`. When sender
 *   threading lands (5D-followup or later), pass it through and the strict
 *   role check engages automatically.
 *
 *   Defense in depth: the agent-runner only registers these MCP tools
 *   inside agent containers; the IPC layer scopes per-group; an attacker
 *   who can write into another group's `tasks/` directory has already
 *   compromised the host filesystem.
 */
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { logger } from './logger.js';
import { pausedGate } from './lifecycle.js';
import {
  isOwner,
  isGlobalAdmin,
  isAdminOfAgentGroup,
} from './permissions/user-roles.js';
import { notifyAgent } from './permissions/approval-primitive.js';
import type { EmergencyStopTask, ResumeProcessingTask } from './ipc/types.js';

/**
 * Resolve whether the caller is allowed to soft-pause/resume an agent group.
 *
 * If `senderUserId` is supplied, run the strict role check (owner / global
 * admin / scoped admin of the agent group). If absent, fall back to the
 * `isMain` heuristic — same pattern as `isAuthorizedAdminOp`. Returns true
 * iff the action should proceed.
 */
function isAdminCaller(
  senderUserId: string | undefined,
  isMain: boolean,
  agentGroupId: string,
): boolean {
  if (senderUserId) {
    return (
      isOwner(senderUserId) ||
      isGlobalAdmin(senderUserId) ||
      isAdminOfAgentGroup(senderUserId, agentGroupId)
    );
  }
  // Legacy fallback while sender threading is incomplete (see file header).
  return isMain;
}

export async function handleEmergencyStop(
  task: Pick<EmergencyStopTask, 'reason' | 'groupFolder' | 'isMain'>,
  senderUserId: string | undefined,
): Promise<void> {
  const ag = getAgentGroupByFolder(task.groupFolder);
  if (!ag) {
    logger.warn(
      { groupFolder: task.groupFolder },
      'emergency_stop dropped: unknown agent group',
    );
    return;
  }
  if (!isAdminCaller(senderUserId, task.isMain, ag.id)) {
    notifyAgent(ag.id, 'emergency_stop denied: sender is not an admin.');
    logger.warn(
      { senderUserId, agentGroupId: ag.id, isMain: task.isMain },
      'emergency_stop dropped: not admin',
    );
    return;
  }
  pausedGate.pause(task.reason ?? `agent ${ag.name}`);
  // Optional: also call groupQueue.emergencyStop() for the kill-now path.
  // TODO(5D-04): wire if/when we want kill-on-pause. The two layers are
  // intentionally separate — see file header.
  notifyAgent(ag.id, 'Host paused. Future inbound is queued.');
}

export async function handleResumeProcessing(
  task: Pick<ResumeProcessingTask, 'reason' | 'groupFolder' | 'isMain'>,
  senderUserId: string | undefined,
): Promise<void> {
  const ag = getAgentGroupByFolder(task.groupFolder);
  if (!ag) {
    logger.warn(
      { groupFolder: task.groupFolder },
      'resume_processing dropped: unknown agent group',
    );
    return;
  }
  if (!isAdminCaller(senderUserId, task.isMain, ag.id)) {
    notifyAgent(ag.id, 'resume_processing denied: sender is not an admin.');
    logger.warn(
      { senderUserId, agentGroupId: ag.id, isMain: task.isMain },
      'resume_processing dropped: not admin',
    );
    return;
  }
  pausedGate.resume(task.reason ?? `agent ${ag.name}`);
  notifyAgent(ag.id, 'Host resumed.');
}
