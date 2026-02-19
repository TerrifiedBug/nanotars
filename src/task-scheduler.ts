import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  SCHEDULED_TASK_IDLE_TIMEOUT,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { ContainerOutput, mapTasksToSnapshot, runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import {
  claimTask,
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { stripInternalTags } from './router.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  getResumePositions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Claim the task immediately so the scheduler won't re-enqueue it
  // while the container is still running (next_run stays NULL until
  // updateTaskAfterRun sets the real next run after completion)
  claimTask(task.id);

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(task.group_folder, isMain, mapTasksToSnapshot(tasks));

  let result: string | null = null;
  let error: string | null = null;
  let hadSuccessfulResponse = false;

  // For group context mode, use the group's current session and resume position
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;
  const resumePositions = deps.getResumePositions();
  const resumeAt =
    task.context_mode === 'group' ? resumePositions[task.group_folder] : undefined;

  // Idle timer: writes _close sentinel after IDLE_TIMEOUT of no output,
  // so the container exits instead of hanging at waitForIpcMessage forever.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Scheduled task idle timeout, closing container stdin');
      deps.queue.closeStdin(task.chat_jid);
    }, SCHEDULED_TASK_IDLE_TIMEOUT);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        resumeAt,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        model: task.model || 'claude-sonnet-4-5',
      },
      (proc, containerName) => deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || streamedOutput.result || 'Unknown error';
          return;
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          const text = stripInternalTags(streamedOutput.result);
          if (text) {
            await deps.sendMessage(task.chat_jid, text);
            hadSuccessfulResponse = true;
          }
          // Only reset idle timer on actual results, not session-update markers
          resetIdleTimer();
        }
      },
    );

    if (idleTimer) clearTimeout(idleTimer);

    // If a response was already delivered, ignore late container timeout errors
    if (output.status === 'error' && hadSuccessfulResponse) {
      logger.info(
        { taskId: task.id },
        'Container timed out after successful response, treating as success',
      );
      error = null;
    } else if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  // Notify user if the task failed (so they don't get silent failures)
  if (error && !hadSuccessfulResponse) {
    const taskLabel = task.prompt.split('\n')[0].slice(0, 60);
    await deps.sendMessage(
      task.chat_jid,
      `[Scheduled task failed] ${taskLabel}\nError: ${error.slice(0, 200)}`,
    ).catch(() => {});
  }

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          () => runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
