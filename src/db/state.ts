import { RegisteredGroup, EngageMode, SenderScope, IgnoredMessagePolicy } from '../types.js';
import { logger } from '../logger.js';
import { getDb } from './init.js';

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

interface RegisteredGroupRow {
  jid: string;
  name: string;
  folder: string;
  pattern: string;
  added_at: string;
  container_config: string | null;
  engage_mode: string;
  sender_scope: string;
  ignored_message_policy: string;
  channel: string | null;
}

function mapRegisteredGroupRow(row: RegisteredGroupRow): RegisteredGroup {
  return {
    name: row.name,
    folder: row.folder,
    pattern: row.pattern,
    added_at: row.added_at,
    channel: row.channel || undefined,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    engage_mode: (row.engage_mode as EngageMode) || 'pattern',
    sender_scope: (row.sender_scope as SenderScope) || 'all',
    ignored_message_policy: (row.ignored_message_policy as IgnoredMessagePolicy) || 'drop',
  };
}

/** Validate folder name from DB to prevent path traversal from corrupted data. */
const SAFE_FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  return SAFE_FOLDER_RE.test(folder) && !RESERVED_FOLDERS.has(folder.toLowerCase());
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = getDb()
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn({ jid, folder: row.folder }, 'Skipping registered group with invalid folder name');
    return undefined;
  }
  return { jid: row.jid, ...mapRegisteredGroupRow(row) };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
  channel?: string,
): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, pattern, added_at, container_config, engage_mode, sender_scope, ignored_message_policy, channel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.pattern,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.engage_mode ?? 'pattern',
    group.sender_scope ?? 'all',
    group.ignored_message_policy ?? 'drop',
    channel || null,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = getDb()
    .prepare('SELECT * FROM registered_groups')
    .all() as RegisteredGroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn({ jid: row.jid, folder: row.folder }, 'Skipping registered group with invalid folder name');
      continue;
    }
    result[row.jid] = mapRegisteredGroupRow(row);
  }
  return result;
}
