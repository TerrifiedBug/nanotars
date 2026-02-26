import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config.js';
import { createTask, deleteTask, getTaskById, isValidGroupFolder, updateTask } from '../db.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { authorizedTaskAction } from './auth.js';
import { IpcDeps } from './types.js';

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

        const validScheduleTypes = new Set(['cron', 'interval', 'once']);
        if (!validScheduleTypes.has(data.schedule_type!)) {
          logger.warn({ scheduleType: data.schedule_type }, 'Invalid schedule_type in task IPC');
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
            const validScheduleTypes = new Set(['cron', 'interval', 'once']);
            if (!validScheduleTypes.has(data.schedule_type)) {
              logger.warn({ scheduleType: data.schedule_type }, 'Invalid schedule_type in update_task IPC');
              break;
            }
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

    case 'emergency_stop': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'emergency_stop rejected: not main group');
        break;
      }
      logger.info({ sourceGroup }, 'Emergency stop requested via IPC');
      if (deps.emergencyStop) await deps.emergencyStop();
      break;
    }

    case 'resume_processing': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'resume_processing rejected: not main group');
        break;
      }
      logger.info({ sourceGroup }, 'Resume requested via IPC');
      if (deps.resumeProcessing) deps.resumeProcessing();
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
