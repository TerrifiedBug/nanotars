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
import { createTask, deleteTask, getTaskById, isValidGroupFolder, updateTask } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/** Discriminated union for IPC message commands. */
type IpcMessage =
  | { type: 'message'; chatJid: string; text: string; sender?: string; replyTo?: string }
  | { type: 'send_file'; chatJid: string; filePath: string; fileName?: string; caption?: string }
  | { type: 'react'; chatJid: string; messageId: string; emoji: string };

/** Type guard for IPC messages. */
function isIpcMessage(data: unknown): data is IpcMessage {
  if (typeof data !== 'object' || data === null || !('type' in data)) return false;
  const d = data as Record<string, unknown>;
  switch (d.type) {
    case 'message':
      return typeof d.chatJid === 'string' && typeof d.text === 'string';
    case 'send_file':
      return typeof d.chatJid === 'string' && typeof d.filePath === 'string';
    case 'react':
      return typeof d.chatJid === 'string' && typeof d.messageId === 'string' && typeof d.emoji === 'string';
    default:
      return false;
  }
}

/** Max file size for send_file (64 MB) */
const SEND_FILE_MAX_SIZE = 64 * 1024 * 1024;

/** Max IPC JSON file size (1 MiB — generous for any valid command) */
const IPC_MAX_FILE_SIZE = 1024 * 1024;

/**
 * Safely read an IPC JSON file:
 *  - lstat to reject symlinks (CWE-59)
 *  - size limit to prevent DoS
 *  - O_NOFOLLOW to prevent TOCTOU race between lstat and open
 * Returns parsed JSON or null on any issue.
 */
async function readIpcJsonFile(filePath: string, sourceGroup: string): Promise<unknown | null> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile()) {
      logger.warn({ filePath, sourceGroup }, 'IPC: not a regular file, skipping');
      return null;
    }
    if (stat.size > IPC_MAX_FILE_SIZE) {
      logger.warn({ filePath, size: stat.size, sourceGroup }, 'IPC: file too large, skipping');
      return null;
    }
    // O_NOFOLLOW prevents symlink race between lstat and open
    const fd = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(stat.size);
      const { bytesRead } = await fd.read(buf, 0, stat.size, 0);
      return JSON.parse(buf.slice(0, bytesRead).toString('utf-8'));
    } finally {
      await fd.close();
    }
  } catch (err) {
    logger.warn({ filePath, sourceGroup, err }, 'IPC: failed to read file safely');
    return null;
  }
}

/**
 * List .json files in an IPC directory, filtering to regular files only.
 * Uses withFileTypes to avoid stat on non-files (directory entry type confusion).
 */
async function listIpcJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Move a failed IPC file to the errors directory. */
function quarantineFile(filePath: string, sourceGroup: string, fileName: string, ipcBaseDir: string): void {
  const errorDir = path.join(ipcBaseDir, 'errors');
  fs.mkdirSync(errorDir, { recursive: true });
  fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${fileName}`));
}

/** Check if a source group is authorized to act on a target JID. */
function isAuthorizedForJid(
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
  sendMessage: (jid: string, text: string, sender?: string, replyTo?: string) => Promise<void>;
  sendFile: (jid: string, buffer: Buffer, mime: string, fileName: string, caption?: string) => Promise<boolean>;
  react: (jid: string, messageId: string, emoji: string) => Promise<void>;
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

export function startIpcWatcher(deps: IpcDeps): Promise<void> {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return Promise.resolve();
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      const entries = await fs.promises.readdir(ipcBaseDir, { withFileTypes: true });
      groupFolders = entries
        .filter((entry) => entry.isDirectory() && entry.name !== 'errors')
        .map((entry) => entry.name);
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
        {
          const messageFiles = await listIpcJsonFiles(messagesDir);
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const raw = await readIpcJsonFile(filePath, sourceGroup);
              if (raw === null) {
                quarantineFile(filePath, sourceGroup, file, ipcBaseDir);
                continue;
              }
              if (!isIpcMessage(raw)) {
                logger.warn({ filePath, sourceGroup, type: (raw as Record<string, unknown>)?.type }, 'IPC: invalid message format');
                quarantineFile(filePath, sourceGroup, file, ipcBaseDir);
                continue;
              }
              const data = raw;
              switch (data.type) {
                case 'message': {
                  if (!isAuthorizedForJid(data.chatJid, registeredGroups, sourceGroup, isMain, 'message')) break;
                  await deps.sendMessage(data.chatJid, data.text, data.sender, data.replyTo);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                  break;
                }
                case 'send_file': {
                  if (!isAuthorizedForJid(data.chatJid, registeredGroups, sourceGroup, isMain, 'send_file')) break;
                  // Translate container path to host path
                  // Container /workspace/group/... → host groups/{folder}/...
                  let hostPath = data.filePath;
                  if (hostPath.startsWith('/workspace/group/')) {
                    hostPath = path.join(GROUPS_DIR, sourceGroup, hostPath.slice('/workspace/group/'.length));
                  }

                  // Prevent path traversal: resolved path must stay within the group directory
                  const groupRoot = path.resolve(path.join(GROUPS_DIR, sourceGroup));
                  const resolvedHost = path.resolve(hostPath);
                  if (!resolvedHost.startsWith(groupRoot + path.sep) && resolvedHost !== groupRoot) {
                    logger.warn({ hostPath, resolvedHost, groupRoot, sourceGroup }, 'send_file: path traversal blocked');
                    fs.unlinkSync(filePath);
                    break;
                  }

                  if (!fs.existsSync(hostPath)) {
                    logger.warn({ hostPath, sourceGroup }, 'send_file: file not found');
                  } else {
                    // Resolve symlinks and re-check containment (path.resolve doesn't follow symlinks)
                    const realHost = fs.realpathSync(hostPath);
                    const realGroup = fs.realpathSync(path.join(GROUPS_DIR, sourceGroup));
                    if (!realHost.startsWith(realGroup + path.sep) && realHost !== realGroup) {
                      logger.warn({ hostPath, realHost, realGroup, sourceGroup }, 'send_file: symlink traversal blocked');
                      fs.unlinkSync(filePath);
                      break;
                    }
                    const stat = fs.statSync(hostPath);
                    if (!stat.isFile()) {
                      logger.warn({ hostPath, sourceGroup }, 'send_file: not a regular file');
                    } else if (stat.size > SEND_FILE_MAX_SIZE) {
                      logger.warn({ hostPath, size: stat.size, sourceGroup }, 'send_file: file too large (64MB limit)');
                    } else {
                      const buffer = fs.readFileSync(hostPath);
                      const mime = mimeFromExtension(hostPath);
                      const fileName = data.fileName || path.basename(hostPath);
                      const caption = data.caption;
                      await deps.sendFile(data.chatJid, buffer, mime, fileName, caption);
                      logger.info(
                        { chatJid: data.chatJid, fileName, mime, size: stat.size, sourceGroup },
                        'IPC file sent',
                      );
                    }
                  }
                  break;
                }
                case 'react': {
                  if (!isAuthorizedForJid(data.chatJid, registeredGroups, sourceGroup, isMain, 'react')) break;
                  await deps.react(data.chatJid, data.messageId, data.emoji);
                  logger.info(
                    { chatJid: data.chatJid, messageId: data.messageId, sourceGroup },
                    'IPC react sent',
                  );
                  break;
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              quarantineFile(filePath, sourceGroup, file, ipcBaseDir);
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
        {
          const taskFiles = await listIpcJsonFiles(tasksDir);
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = await readIpcJsonFile(filePath, sourceGroup);
              if (data === null) {
                quarantineFile(filePath, sourceGroup, file, ipcBaseDir);
                continue;
              }
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data as any, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
              quarantineFile(filePath, sourceGroup, file, ipcBaseDir);
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  const firstRun = processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
  return firstRun;
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

/** Compute the next run time for a schedule. Returns null nextRun on parse error. */
function computeNextRun(
  type: string,
  value: string,
): { nextRun: string | null; valid: boolean } {
  if (type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(value, { tz: TIMEZONE });
      return { nextRun: interval.next().toISOString(), valid: true };
    } catch {
      logger.warn({ scheduleValue: value }, 'Invalid cron expression');
      return { nextRun: null, valid: false };
    }
  } else if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (isNaN(ms) || ms <= 0) {
      logger.warn({ scheduleValue: value }, 'Invalid interval');
      return { nextRun: null, valid: false };
    }
    return { nextRun: new Date(Date.now() + ms).toISOString(), valid: true };
  } else if (type === 'once') {
    // Treat bare datetime strings (no Z or ±HH:MM) as UTC to avoid
    // silent local-timezone interpretation on the server.
    const hasTimezone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value);
    const scheduled = new Date(hasTimezone ? value : value + 'Z');
    if (isNaN(scheduled.getTime())) {
      logger.warn({ scheduleValue: value }, 'Invalid timestamp');
      return { nextRun: null, valid: false };
    }
    return { nextRun: scheduled.toISOString(), valid: true };
  }
  return { nextRun: null, valid: true };
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

        const { nextRun, valid } = computeNextRun(scheduleType, data.schedule_value);
        if (!valid) break;

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
          if (data.schedule_type && data.schedule_value) {
            updates.schedule_type = data.schedule_type as 'cron' | 'interval' | 'once';
            updates.schedule_value = data.schedule_value as string;
            const { nextRun, valid } = computeNextRun(data.schedule_type, data.schedule_value);
            if (!valid) break;
            updates.next_run = nextRun;
          }

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
        if (!isValidGroupFolder(data.folder)) {
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
