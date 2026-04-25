import { getTaskById } from '../db.js';
import { logger } from '../logger.js';

/**
 * Auth helpers consume only the `folder` field of the per-JID record; the
 * full `RegisteredGroup` shape isn't needed and avoids importing the
 * legacy type. The deps callback that supplies this map is itself now
 * backed by the entity-model synthesizer in the orchestrator.
 */
type JidFolderMap = Record<string, { folder: string } | undefined>;

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
