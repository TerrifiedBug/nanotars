import { ScheduledTask, TaskRunLog } from '../types.js';
import { getDb } from './init.js';

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  getDb().prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, model, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.model || 'claude-sonnet-4-5',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return getDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return getDb()
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status' | 'model'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }

  if (fields.length === 0) return;

  values.push(id);
  getDb().prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  getDb().prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

/**
 * Claim a task for execution by clearing its next_run.
 * Prevents the scheduler from re-enqueuing it while it's running.
 */
export function claimTask(id: string): void {
  getDb().prepare(`UPDATE scheduled_tasks SET next_run = NULL WHERE id = ?`).run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return getDb()
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function getTaskRunLogs(taskId: string, limit = 50): TaskRunLog[] {
  return getDb()
    .prepare('SELECT task_id, run_at, duration_ms, status, result, error FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?')
    .all(taskId, limit) as TaskRunLog[];
}

/** Get recent task run logs across all tasks with a single JOIN query. */
export function getRecentTaskRunLogs(limit = 15): Array<TaskRunLog & { group_folder: string; prompt: string }> {
  return getDb()
    .prepare(`
      SELECT trl.task_id, trl.run_at, trl.duration_ms, trl.status, trl.result, trl.error,
             st.group_folder, st.prompt
      FROM task_run_logs trl
      JOIN scheduled_tasks st ON trl.task_id = st.id
      ORDER BY trl.run_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<TaskRunLog & { group_folder: string; prompt: string }>;
}

export function logTaskRun(log: TaskRunLog): void {
  getDb().prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

/** Delete task_run_logs older than the given number of days. */
export function pruneTaskRunLogs(olderThanDays = 30): number {
  const result = getDb().prepare(
    `DELETE FROM task_run_logs WHERE run_at < datetime('now', ?)`,
  ).run(`-${olderThanDays} days`);
  return result.changes;
}

/** Delete all scheduled tasks for a given group folder. Returns count deleted. */
export function deleteTasksForGroup(groupFolder: string): number {
  const result = getDb().prepare(
    'DELETE FROM scheduled_tasks WHERE group_folder = ?',
  ).run(groupFolder);
  return result.changes;
}
