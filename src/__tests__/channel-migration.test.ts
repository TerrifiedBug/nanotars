import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyChannelMigration,
  planChannelMigration,
} from '../channel-migration.js';
import {
  createAgentGroup,
  createMessagingGroup,
  createWiring,
  getMessagingGroup,
  resolveAgentsForInbound,
} from '../db/agent-groups.js';
import { _initTestDatabase, getDb } from '../db/init.js';
import { createTask, getTasksForGroup } from '../db/tasks.js';

let tmpDir: string;

function writePlugin(name: string, manifest: Record<string, unknown>): void {
  const dir = path.join(tmpDir, 'plugins', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    `${JSON.stringify({ name, ...manifest }, null, 2)}\n`,
  );
}

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-migration-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('channel migration planning', () => {
  it('plans DB cleanup and safe single-group plugin scope updates', () => {
    const group = createAgentGroup({ name: 'Work', folder: 'work' });
    const oldChat = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'wa:old',
      name: 'Old WhatsApp',
      is_group: 1,
    });
    createWiring({ messaging_group_id: oldChat.id, agent_group_id: group.id });
    createTask({
      id: 'task-1',
      group_folder: 'work',
      chat_jid: 'wa:old',
      prompt: 'do thing',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'group',
      model: 'claude-sonnet-4-5',
      script: null,
      next_run: '2026-05-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-05-01T00:00:00.000Z',
    });
    writePlugin('scoped', { channels: ['whatsapp'], groups: ['work'] });
    writePlugin('global', { channels: ['*'], groups: ['*'] });
    writePlugin('shared', {
      channels: ['whatsapp'],
      groups: ['work', 'other'],
    });

    const plan = planChannelMigration({
      agentGroup: group,
      fromChannel: 'whatsapp',
      toChannel: 'telegram',
      projectRoot: tmpDir,
    });

    expect(plan.sourceWirings).toHaveLength(1);
    expect(plan.tasksToMove).toBe(1);
    expect(plan.pluginScopeUpdates).toEqual([
      expect.objectContaining({
        name: 'scoped',
        fromChannels: ['whatsapp'],
        toChannels: ['telegram'],
      }),
    ]);
    expect(plan.pluginScopeWarnings).toEqual([
      expect.objectContaining({ name: 'shared' }),
    ]);
  });

  it('applies the DB migration and rewrites safe plugin channel scopes', () => {
    const group = createAgentGroup({ name: 'Work', folder: 'work' });
    const oldChat = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'wa:old',
      name: 'Old WhatsApp',
      is_group: 1,
    });
    const newChat = createMessagingGroup({
      channel_type: 'telegram',
      platform_id: 'tg:new',
      name: 'New Telegram',
      is_group: 1,
    });
    createWiring({ messaging_group_id: oldChat.id, agent_group_id: group.id });
    createWiring({ messaging_group_id: newChat.id, agent_group_id: group.id });
    createTask({
      id: 'task-1',
      group_folder: 'work',
      chat_jid: 'wa:old',
      prompt: 'do thing',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'group',
      model: 'claude-sonnet-4-5',
      script: null,
      next_run: '2026-05-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-05-01T00:00:00.000Z',
    });
    getDb()
      .prepare(
        `INSERT INTO pending_questions
          (question_id, session_id, message_out_id, platform_id, channel_type, title, options_json, created_at)
         VALUES ('q1', 's1', 'm1', 'wa:old', 'whatsapp', 'Question', '[]', ?)`,
      )
      .run('2026-05-01T00:00:00.000Z');
    writePlugin('scoped', { channels: ['whatsapp'], groups: ['work'] });

    const result = applyChannelMigration({
      agentGroup: group,
      fromChannel: 'whatsapp',
      newMessagingGroup: newChat,
      projectRoot: tmpDir,
    });

    expect(result.pluginScopesUpdated).toHaveLength(1);
    expect(getMessagingGroup('whatsapp', 'wa:old')).toBeUndefined();
    expect(resolveAgentsForInbound('telegram', 'tg:new')).toHaveLength(1);
    expect(getTasksForGroup('work')[0].chat_jid).toBe('tg:new');
    const pendingQuestion = getDb()
      .prepare(`SELECT * FROM pending_questions WHERE question_id = 'q1'`)
      .get();
    expect(pendingQuestion).toBeUndefined();
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, 'plugins', 'scoped', 'plugin.json'),
        'utf8',
      ),
    );
    expect(manifest.channels).toEqual(['telegram']);
  });
});
