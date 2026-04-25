import { getTaskById } from '../db.js';
import { logger } from '../logger.js';
import {
  isAdminCommand,
  checkCommandPermission,
  type CommandPermissionDecision,
} from '../command-gate.js';
import type { JidFolderMap } from './types.js';

// Re-export command-gate helpers so callers that already import from
// './auth.js' can reach them without a second import path.
export { isAdminCommand, checkCommandPermission };
export type { CommandPermissionDecision };

/** Check if a source group is authorized to act on a target JID. */
export function isAuthorizedForJid(
  chatJid: string,
  registeredGroups: JidFolderMap,
  sourceGroup: string,
  isMain: boolean,
  action: string,
): boolean {
  const targetGroup = registeredGroups[chatJid];
  if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) return true;
  logger.warn({ chatJid, sourceGroup }, `Unauthorized IPC ${action} attempt blocked`);
  return false;
}

/**
 * Gate an admin IPC operation using the role-based command-gate.
 *
 * This is the Phase 4B wiring point. Currently the IPC layer identifies
 * callers by `sourceGroup` (filesystem directory) rather than by a
 * `userId`, so full role-based enforcement requires threading userId
 * through every IPC payload — planned for Phase 4D.
 *
 * Until then this function provides the wiring pattern:
 *  - If a `userId` is available on the payload, it is checked via
 *    `checkCommandPermission` against the agent group.
 *  - If no `userId` is present, the legacy `isMain` heuristic is used
 *    as a fallback so existing behaviour is preserved.
 *
 * TODO(Phase 4D): remove the `isMain` fallback once all IPC payloads
 * carry a `userId` field and the threading is complete.
 */
export function isAuthorizedAdminOp(args: {
  command: string;
  sourceGroup: string;
  isMain: boolean;
  userId?: string;
  agentGroupId?: string;
  action: string;
}): boolean {
  const { command, sourceGroup, isMain, userId, agentGroupId, action } = args;

  // Role-based path: if we have both userId and agentGroupId, use the gate.
  if (userId !== undefined && agentGroupId !== undefined) {
    if (!isAdminCommand(command)) {
      // Not classified as an admin command — fall back to legacy check.
      if (!isMain) {
        logger.warn({ command, sourceGroup }, `Unauthorized IPC ${action} attempt blocked`);
        return false;
      }
      return true;
    }
    const decision = checkCommandPermission(userId, command, agentGroupId);
    if (!decision.allowed) {
      logger.warn(
        { command, userId, agentGroupId, sourceGroup, reason: decision.reason },
        `Admin IPC ${action} denied by command-gate`,
      );
      return false;
    }
    return true;
  }

  // Legacy fallback: no userId threaded through — use isMain heuristic.
  if (!isMain) {
    logger.warn({ command, sourceGroup }, `Unauthorized IPC ${action} attempt blocked`);
    return false;
  }
  return true;
}

/** Authorize and execute a task action (pause/resume/cancel) with consistent logging. */
export function authorizedTaskAction(
  taskId: string | undefined,
  sourceGroup: string,
  isMain: boolean,
  label: string,
  action: (id: string) => void,
): void {
  if (!taskId) return;
  const task = getTaskById(taskId);
  if (task && (isMain || task.group_folder === sourceGroup)) {
    action(taskId);
    logger.info({ taskId, sourceGroup }, `Task ${label} via IPC`);
  } else {
    logger.warn({ taskId, sourceGroup }, `Unauthorized task ${label} attempt`);
  }
}
