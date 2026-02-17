import { describe, it, expect, beforeEach, vi } from 'vitest';

import Database from 'better-sqlite3';
import {
  _initTestDatabase,
  _initTestDatabaseFrom,
  _getSchemaVersion,
  createTask,
  dbEvents,
  deleteTask,
  getAllChats,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  insertExternalMessage,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'TARS');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('stores empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'TARS');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('');
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'TARS');
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'TARS');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1', chat_jid: 'group@g.us', sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice', content: 'first', timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2', chat_jid: 'group@g.us', sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob', content: 'second', timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3', chat_jid: 'group@g.us', sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot', content: 'bot reply', timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4', chat_jid: 'group@g.us', sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol', content: 'third', timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince('group@g.us', '2024-01-01T00:00:02.000Z', 'TARS');
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'TARS');
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'TARS');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5', chat_jid: 'group@g.us', sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot', content: 'TARS: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince('group@g.us', '2024-01-01T00:00:04.000Z', 'TARS');
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1', chat_jid: 'group1@g.us', sender: 'user@s.whatsapp.net',
      sender_name: 'User', content: 'g1 msg1', timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2', chat_jid: 'group2@g.us', sender: 'user@s.whatsapp.net',
      sender_name: 'User', content: 'g2 msg1', timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3', chat_jid: 'group1@g.us', sender: 'user@s.whatsapp.net',
      sender_name: 'User', content: 'bot reply', timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4', chat_jid: 'group1@g.us', sender: 'user@s.whatsapp.net',
      sender_name: 'User', content: 'g1 msg2', timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'TARS',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp (>= comparison)', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'TARS',
    );
    // With >= comparison: a2 (at cursor ts=02) AND a4 (after cursor), not a3 (bot)
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('g2 msg1');
    expect(messages[1].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'TARS');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });

  it('returns same-second messages on subsequent poll (dedup fix)', () => {
    // Setup: only one group with a single message at ts=05
    storeChatMetadata('group3@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'b1',
      chat_jid: 'group3@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'first msg',
      timestamp: '2024-01-01T00:00:05.000Z',
    });

    // First poll: cursor advances to ts=05
    const { messages: first, newTimestamp: ts1 } = getNewMessages(
      ['group3@g.us'],
      '2024-01-01T00:00:00.000Z',
      'TARS',
    );
    expect(first).toHaveLength(1);
    expect(ts1).toBe('2024-01-01T00:00:05.000Z');

    // A late message arrives at the SAME second (ts=05)
    store({
      id: 'b2',
      chat_jid: 'group3@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'late arrival same second',
      timestamp: '2024-01-01T00:00:05.000Z',
    });

    // Second poll using ts1 as cursor — with >= comparison, b2 is found
    // (along with b1 which the caller must filter via processedIds)
    const { messages: second } = getNewMessages(
      ['group3@g.us'],
      ts1,
      'TARS',
    );
    const hasLateArrival = second.some((m) => m.id === 'b2');
    expect(hasLateArrival).toBe(true);
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- Schema version table ---

describe('schema_version', () => {
  it('creates version table with all migrations applied', () => {
    const versions = _getSchemaVersion();
    expect(versions.length).toBe(4);
    expect(versions[0].version).toBe('001_add_context_mode');
    expect(versions[3].version).toBe('004_add_is_bot_message');
  });

  it('is idempotent on re-init', () => {
    const before = _getSchemaVersion();
    // Re-initializing should not duplicate entries
    _initTestDatabase();
    const after = _getSchemaVersion();
    expect(after.length).toBe(before.length);
  });

  it('records applied_at timestamp', () => {
    const versions = _getSchemaVersion();
    for (const v of versions) {
      expect(v.applied_at).toBeTruthy();
      // Should be a valid ISO date
      expect(new Date(v.applied_at).toISOString()).toBe(v.applied_at);
    }
  });

  it('handles partial migration state (brownfield upgrade)', () => {
    // Simulate a DB where old ALTER-TABLE system applied 001-003 but not 004.
    // Base schema without is_bot_message, but WITH context_mode/model/channel.
    const partialDb = new Database(':memory:');
    partialDb.exec(`
      CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT,
        is_from_me INTEGER,
        PRIMARY KEY (id, chat_jid), FOREIGN KEY (chat_jid) REFERENCES chats(jid)
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON messages(chat_jid, timestamp);
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL,
        prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL,
        context_mode TEXT DEFAULT 'isolated', model TEXT DEFAULT 'claude-sonnet-4-5',
        next_run TEXT, last_run TEXT, last_result TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registered_groups (
        jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL, container_config TEXT,
        requires_trigger INTEGER DEFAULT 1, channel TEXT
      );
    `);
    // No schema_version table, no is_bot_message column — partial old-system state

    // This should NOT throw "duplicate column name"
    _initTestDatabaseFrom(partialDb);

    const versions = _getSchemaVersion();
    expect(versions.length).toBe(4);
    expect(versions.map((v) => v.version)).toEqual([
      '001_add_context_mode', '002_add_model', '003_add_channel', '004_add_is_bot_message',
    ]);
  });
});

// --- dbEvents ---

describe('dbEvents', () => {
  it('emits new-message on storeMessage', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const handler = vi.fn();
    dbEvents.on('new-message', handler);
    try {
      storeMessage({
        id: 'evt-1', chat_jid: 'group@g.us', sender: 'user@s.whatsapp.net',
        sender_name: 'User', content: 'hello', timestamp: '2024-01-01T00:00:01.000Z',
      });
      expect(handler).toHaveBeenCalledWith('group@g.us');
    } finally {
      dbEvents.off('new-message', handler);
    }
  });

  it('emits new-message on insertExternalMessage', () => {
    const handler = vi.fn();
    dbEvents.on('new-message', handler);
    try {
      insertExternalMessage('ext@g.us', 'ext-1', 'sender@s', 'Sender', 'external msg');
      expect(handler).toHaveBeenCalledWith('ext@g.us');
    } finally {
      dbEvents.off('new-message', handler);
    }
  });
});
