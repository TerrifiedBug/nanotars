import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME } from '../config.js';
import { getAllAgentGroups, getAllSynthesizedGroupRows } from '../db/agent-groups.js';
import { getDb } from '../db/init.js';
import { getAllTasks, getRecentTaskRunLogs } from '../db/tasks.js';
import { getRuntimeSummary, listRuntimeContainers } from '../db/runtime.js';

export interface DashboardSnapshot {
  generated_at: string;
  assistant_name: string;
  health: {
    dashboard_pid: number;
    dashboard_uptime_sec: number;
    host_pid: number | null;
    host_status: 'running' | 'stale' | 'unknown';
    node: string;
    memory_mb: number;
  };
  counts: {
    groups: number;
    channels: number;
    chats: number;
    tasks: number;
    active_tasks: number;
    plugins: number;
    active_containers: number;
    recent_failures: number;
  };
  groups: Array<{
    id: string;
    folder: string;
    name: string;
    provider: string | null;
    wirings: Array<{
      channel: string;
      platform_id: string;
      name: string | null;
      engage_mode: string;
      sender_scope: string;
      priority: number;
    }>;
    tasks: number;
    recent_messages: number;
    active_containers: number;
  }>;
  channels: Array<{
    channel: string;
    chats: number;
    group_chats: number;
    latest_activity: string | null;
  }>;
  tasks: Array<{
    id: string;
    group_folder: string;
    chat_jid: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
    last_run: string | null;
    last_result: string | null;
  }>;
  recent_runs: ReturnType<typeof getRecentTaskRunLogs>;
  runtime: ReturnType<typeof getRuntimeSummary> & {
    containers: ReturnType<typeof listRuntimeContainers>;
  };
  plugins: Array<{
    name: string;
    version: string | null;
    type: 'channel' | 'skill';
    channels: string[];
    groups: string[];
  }>;
  recent_messages: Array<{
    id: string;
    chat_jid: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: number | boolean | null;
    is_bot_message: number | boolean | null;
  }>;
}

export function collectDashboardSnapshot(projectRoot: string, now = new Date()): DashboardSnapshot {
  const groups = getAllAgentGroups();
  const wirings = getAllSynthesizedGroupRows();
  const tasks = getAllTasks();
  const runtime = getRuntimeSummary(now);
  const recentContainers = listRuntimeContainers({ limit: 25 });
  const recentMessages = recentMessagesRows(50);
  const host = hostProcessStatus(projectRoot);

  return {
    generated_at: now.toISOString(),
    assistant_name: ASSISTANT_NAME,
    health: {
      dashboard_pid: process.pid,
      dashboard_uptime_sec: Math.floor(process.uptime()),
      host_pid: host.pid,
      host_status: host.status,
      node: process.version,
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    counts: {
      groups: groups.length,
      channels: scalarCount('SELECT COUNT(DISTINCT channel_type) AS count FROM messaging_groups'),
      chats: scalarCount('SELECT COUNT(*) AS count FROM messaging_groups'),
      tasks: tasks.length,
      active_tasks: tasks.filter((task) => task.status === 'active').length,
      plugins: pluginRows(projectRoot).length,
      active_containers: runtime.active,
      recent_failures: runtime.recent_failures,
    },
    groups: groups.map((group) => {
      const groupWirings = wirings.filter((wiring) => wiring.agent_group_id === group.id);
      return {
        id: group.id,
        folder: group.folder,
        name: group.name,
        provider: group.agent_provider,
        wirings: groupWirings.map((wiring) => ({
          channel: wiring.channel_type,
          platform_id: wiring.platform_id,
          name: null,
          engage_mode: wiring.wiring_engage_mode,
          sender_scope: wiring.wiring_sender_scope,
          priority: wiring.wiring_priority,
        })),
        tasks: tasks.filter((task) => task.group_folder === group.folder).length,
        recent_messages: groupWirings.reduce(
          (count, wiring) => count + scalarCount('SELECT COUNT(*) AS count FROM messages WHERE chat_jid = ?', wiring.platform_id),
          0,
        ),
        active_containers: recentContainers.filter(
          (container) => container.group_folder === group.folder && ['starting', 'running'].includes(container.status),
        ).length,
      };
    }),
    channels: channelRows(),
    tasks: tasks.map((task) => ({
      id: task.id,
      group_folder: task.group_folder,
      chat_jid: task.chat_jid,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
      last_run: task.last_run,
      last_result: task.last_result,
    })),
    recent_runs: getRecentTaskRunLogs(20),
    runtime: {
      ...runtime,
      containers: recentContainers,
    },
    plugins: pluginRows(projectRoot),
    recent_messages: recentMessages,
  };
}

function scalarCount(sql: string, ...args: unknown[]): number {
  const row = getDb().prepare(sql).get(...args) as { count?: number };
  return Number(row.count ?? 0);
}

function channelRows(): DashboardSnapshot['channels'] {
  return getDb()
    .prepare(
      `SELECT mg.channel_type AS channel,
              COUNT(*) AS chats,
              SUM(CASE WHEN mg.is_group = 1 THEN 1 ELSE 0 END) AS group_chats,
              MAX(c.last_message_time) AS latest_activity
       FROM messaging_groups mg
       LEFT JOIN chats c ON c.jid = mg.platform_id
       GROUP BY mg.channel_type
       ORDER BY mg.channel_type`,
    )
    .all() as DashboardSnapshot['channels'];
}

function recentMessagesRows(limit: number): DashboardSnapshot['recent_messages'] {
  return getDb()
    .prepare(
      `SELECT id, chat_jid, sender_name, content, timestamp, is_from_me, is_bot_message
       FROM messages
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(limit) as DashboardSnapshot['recent_messages'];
}

function pluginRows(projectRoot: string): DashboardSnapshot['plugins'] {
  const manifests = [
    ...readManifests(path.join(projectRoot, 'plugins'), 'skill'),
    ...readManifests(path.join(projectRoot, 'plugins', 'channels'), 'channel'),
  ];
  const seen = new Set<string>();
  return manifests.filter((plugin) => {
    const key = `${plugin.type}:${plugin.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

function readManifests(root: string, fallbackType: 'channel' | 'skill'): DashboardSnapshot['plugins'] {
  if (!fs.existsSync(root)) return [];
  const out: DashboardSnapshot['plugins'] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'plugin.json');
    if (!fs.existsSync(file)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        name?: string;
        version?: string;
        type?: string;
        channelPlugin?: boolean;
        channels?: string[];
        groups?: string[];
      };
      out.push({
        name: manifest.name ?? entry.name,
        version: manifest.version ?? null,
        type: manifest.channelPlugin === true || manifest.type === 'channel' ? 'channel' : fallbackType,
        channels: manifest.channels ?? ['*'],
        groups: manifest.groups ?? ['*'],
      });
    } catch {
      // Malformed plugin manifests are surfaced by `nanotars plugins list`.
    }
  }
  return out;
}

function hostProcessStatus(projectRoot: string): { pid: number | null; status: 'running' | 'stale' | 'unknown' } {
  const pidFile = path.join(projectRoot, 'data', 'host.pid');
  if (!fs.existsSync(pidFile)) return { pid: null, status: 'unknown' };
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isFinite(pid) || pid <= 0) return { pid: null, status: 'unknown' };
  try {
    process.kill(pid, 0);
    return { pid, status: 'running' };
  } catch {
    return { pid, status: 'stale' };
  }
}
