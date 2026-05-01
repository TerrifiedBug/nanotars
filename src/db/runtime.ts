import crypto from 'crypto';

import { getDb } from './init.js';

export type RuntimeContainerStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'spawn_error';

export interface RuntimeContainerRow {
  run_id: string;
  container_name: string;
  agent_group_id: string | null;
  group_folder: string;
  group_name: string | null;
  chat_jid: string | null;
  task_id: string | null;
  reason: string;
  status: RuntimeContainerStatus;
  model: string | null;
  pid: number | null;
  exit_code: number | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  heartbeat_at: string | null;
  current_tool: string | null;
  log_file: string | null;
  error: string | null;
}

export interface StartRuntimeContainerArgs {
  container_name: string;
  agent_group_id?: string | null;
  group_folder: string;
  group_name?: string | null;
  chat_jid?: string | null;
  task_id?: string | null;
  reason: string;
  model?: string | null;
  pid?: number | null;
  log_file?: string | null;
  started_at?: string;
}

export interface FinishRuntimeContainerArgs {
  run_id: string;
  status: Extract<RuntimeContainerStatus, 'completed' | 'failed' | 'timeout' | 'spawn_error'>;
  exit_code?: number | null;
  error?: string | null;
  finished_at?: string;
}

export function recordRuntimeContainerStart(args: StartRuntimeContainerArgs): RuntimeContainerRow {
  const now = args.started_at ?? new Date().toISOString();
  const row: RuntimeContainerRow = {
    run_id: crypto.randomUUID(),
    container_name: args.container_name,
    agent_group_id: args.agent_group_id ?? null,
    group_folder: args.group_folder,
    group_name: args.group_name ?? null,
    chat_jid: args.chat_jid ?? null,
    task_id: args.task_id ?? null,
    reason: args.reason,
    status: 'running',
    model: args.model ?? null,
    pid: args.pid ?? null,
    exit_code: null,
    started_at: now,
    updated_at: now,
    finished_at: null,
    heartbeat_at: now,
    current_tool: null,
    log_file: args.log_file ?? null,
    error: null,
  };
  const database = getDb();
  if (!database) return row;
  database
    .prepare(
      `INSERT INTO runtime_containers (
        run_id, container_name, agent_group_id, group_folder, group_name,
        chat_jid, task_id, reason, status, model, pid, exit_code,
        started_at, updated_at, finished_at, heartbeat_at, current_tool,
        log_file, error
      ) VALUES (
        @run_id, @container_name, @agent_group_id, @group_folder, @group_name,
        @chat_jid, @task_id, @reason, @status, @model, @pid, @exit_code,
        @started_at, @updated_at, @finished_at, @heartbeat_at, @current_tool,
        @log_file, @error
      )`,
    )
    .run(row);
  return row;
}

export function finishRuntimeContainer(args: FinishRuntimeContainerArgs): void {
  const finishedAt = args.finished_at ?? new Date().toISOString();
  const database = getDb();
  if (!database) return;
  database
    .prepare(
      `UPDATE runtime_containers
       SET status = @status,
           exit_code = @exit_code,
           error = @error,
           finished_at = @finished_at,
           updated_at = @finished_at,
           heartbeat_at = @finished_at
       WHERE run_id = @run_id`,
    )
    .run({
      run_id: args.run_id,
      status: args.status,
      exit_code: args.exit_code ?? null,
      error: args.error ?? null,
      finished_at: finishedAt,
    });
}

export function touchRuntimeContainer(runId: string, at = new Date().toISOString()): void {
  const database = getDb();
  if (!database) return;
  database
    .prepare(
      `UPDATE runtime_containers
       SET heartbeat_at = ?, updated_at = ?
       WHERE run_id = ?`,
    )
    .run(at, at, runId);
}

export function listRuntimeContainers(options: { limit?: number; activeOnly?: boolean } = {}): RuntimeContainerRow[] {
  const limit = Math.max(1, Math.min(options.limit ?? 25, 200));
  const activeWhere = options.activeOnly ? `WHERE status IN ('starting', 'running')` : '';
  return getDb()
    .prepare(
      `SELECT *
       FROM runtime_containers
       ${activeWhere}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as RuntimeContainerRow[];
}

export function getRuntimeSummary(now = new Date()): {
  active: number;
  recent_failures: number;
  latest: RuntimeContainerRow[];
} {
  const active = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM runtime_containers WHERE status IN ('starting', 'running')`)
    .get() as { count: number };
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const recentFailures = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM runtime_containers
       WHERE status IN ('failed', 'timeout', 'spawn_error')
         AND updated_at >= ?`,
    )
    .get(since) as { count: number };
  return {
    active: active.count,
    recent_failures: recentFailures.count,
    latest: listRuntimeContainers({ limit: 10 }),
  };
}
