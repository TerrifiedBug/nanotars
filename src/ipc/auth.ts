import { getTaskById } from '../db.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

/** Check if a source group is authorized to act on a target JID. */
export function isAuthorizedForJid(
  chatJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
  sourceGroup: string,
  isMain: boolean,
  action: string,
): boolean {
  const targetGroup = registeredGroups[chatJid];
  if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) return true;
  logger.warn({ chatJid, sourceGroup }, `Unauthorized IPC ${action} attempt blocked`);
  return false;
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
