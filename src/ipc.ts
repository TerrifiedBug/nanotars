import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/** Max file size for send_file (64 MB) */
const SEND_FILE_MAX_SIZE = 64 * 1024 * 1024;

/** Infer MIME type from file extension */
function mimeFromExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.pdf': 'application/pdf', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  sendFile: (jid: string, buffer: Buffer, mime: string, fileName: string, caption?: string) => Promise<boolean>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text, data.sender);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'send_file' && data.chatJid && data.filePath) {
                // Authorization: same as message
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Translate container path to host path
                  // Container /workspace/group/... → host groups/{folder}/...
                  let hostPath = data.filePath as string;
                  if (hostPath.startsWith('/workspace/group/')) {
                    hostPath = path.join(GROUPS_DIR, sourceGroup, hostPath.slice('/workspace/group/'.length));
                  }

                  if (!fs.existsSync(hostPath)) {
                    logger.warn({ hostPath, sourceGroup }, 'send_file: file not found');
                  } else {
                    const stat = fs.statSync(hostPath);
                    if (!stat.isFile()) {
                      logger.warn({ hostPath, sourceGroup }, 'send_file: not a regular file');
                    } else if (stat.size > SEND_FILE_MAX_SIZE) {
                      logger.warn({ hostPath, size: stat.size, sourceGroup }, 'send_file: file too large (64MB limit)');
                    } else {
                      const buffer = fs.readFileSync(hostPath);
                      const mime = mimeFromExtension(hostPath);
                      const fileName = (data.fileName as string) || path.basename(hostPath);
                      const caption = data.caption as string | undefined;
                      await deps.sendFile(data.chatJid, buffer, mime, fileName, caption);
                      logger.info(
                        { chatJid: data.chatJid, fileName, mime, size: stat.size, sourceGroup },
                        'IPC file sent',
                      );
                    }
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC send_file attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

/** Authorize and execute a task action (pause/resume/cancel) with consistent logging. */
function authorizedTaskAction(
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

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    model?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          model: data.model || null,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      authorizedTaskAction(data.taskId, sourceGroup, isMain, 'paused',
        (id) => updateTask(id, { status: 'paused' }));
      break;

    case 'resume_task':
      authorizedTaskAction(data.taskId, sourceGroup, isMain, 'resumed',
        (id) => updateTask(id, { status: 'active' }));
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          const updates: { prompt?: string; schedule_type?: 'cron' | 'interval' | 'once'; schedule_value?: string; next_run?: string | null; model?: string | null } = {};
          const trimmedPrompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
          if (trimmedPrompt) updates.prompt = trimmedPrompt;
          if (data.model) updates.model = data.model as string;

          // If schedule changed, recompute next_run
          let scheduleValid = true;
          if (data.schedule_type && data.schedule_value) {
            updates.schedule_type = data.schedule_type as 'cron' | 'interval' | 'once';
            updates.schedule_value = data.schedule_value as string;
            const schedType = data.schedule_type as string;
            if (schedType === 'cron') {
              try {
                const interval = CronExpressionParser.parse(
                  data.schedule_value as string,
                  { tz: TIMEZONE },
                );
                updates.next_run = interval.next().toISOString();
              } catch {
                logger.warn({ taskId: data.taskId, scheduleValue: data.schedule_value }, 'Invalid cron in update_task, update rejected');
                scheduleValid = false;
              }
            } else if (schedType === 'interval') {
              const ms = parseInt(data.schedule_value as string, 10);
              if (isNaN(ms) || ms <= 0) {
                logger.warn({ taskId: data.taskId, scheduleValue: data.schedule_value }, 'Invalid interval in update_task, update rejected');
                scheduleValid = false;
              } else {
                updates.next_run = new Date(Date.now() + ms).toISOString();
              }
            } else if (schedType === 'once') {
              const scheduled = new Date(data.schedule_value as string);
              if (isNaN(scheduled.getTime())) {
                logger.warn({ taskId: data.taskId, scheduleValue: data.schedule_value }, 'Invalid timestamp in update_task, update rejected');
                scheduleValid = false;
              } else {
                updates.next_run = scheduled.toISOString();
              }
            }
          }

          if (!scheduleValid) break;

          updateTask(data.taskId, updates);
          logger.info(
            { taskId: data.taskId, sourceGroup, updates: Object.keys(updates) },
            'Task updated via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized or unknown task update attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      authorizedTaskAction(data.taskId, sourceGroup, isMain, 'cancelled',
        (id) => deleteTask(id));
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        // Validate folder name: allowlist of safe characters only
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(data.folder)) {
          logger.warn(
            { folder: data.folder },
            'Rejected register_group with invalid folder name (path traversal attempt)',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
