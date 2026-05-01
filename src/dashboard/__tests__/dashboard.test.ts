import http from 'http';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createAgentGroup,
  createMessagingGroup,
  createTask,
  createWiring,
  getTaskById,
  storeChatMetadata,
  storeMessage,
} from '../../db/index.js';
import { collectDashboardSnapshot } from '../snapshot.js';
import { startDashboardServer } from '../server.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('dashboard snapshot', () => {
  it('collects groups, channels, tasks, plugins, and messages', () => {
    const group = createAgentGroup({ name: 'Main', folder: 'main' });
    const messagingGroup = createMessagingGroup({
      channel_type: 'telegram',
      platform_id: 'tg:main',
      name: 'Main Chat',
      is_group: 1,
    });
    createWiring({ agent_group_id: group.id, messaging_group_id: messagingGroup.id });
    storeChatMetadata('tg:main', '2026-05-01T10:00:00.000Z', 'Main Chat');
    storeMessage({
      id: 'm1',
      chat_jid: 'tg:main',
      sender: 'tg:alice',
      sender_name: 'Alice',
      content: 'hello',
      timestamp: '2026-05-01T10:00:00.000Z',
    });
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'tg:main',
      prompt: 'check status',
      schedule_type: 'once',
      schedule_value: '2026-05-01T10:30:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-05-01T10:30:00.000Z',
      status: 'active',
      created_at: '2026-05-01T10:00:00.000Z',
    });

    const snapshot = collectDashboardSnapshot(process.cwd(), new Date('2026-05-01T10:05:00.000Z'));

    expect(snapshot.counts.groups).toBe(1);
    expect(snapshot.counts.channels).toBe(1);
    expect(snapshot.counts.tasks).toBe(1);
    expect(snapshot.groups[0]).toMatchObject({ folder: 'main', tasks: 1, recent_messages: 1 });
    expect(snapshot.channels[0]).toMatchObject({ channel: 'telegram', chats: 1, group_chats: 1 });
    expect(snapshot.recent_messages[0]).toMatchObject({ id: 'm1', content: 'hello' });
  });
});

describe('dashboard server', () => {
  it('requires bearer auth and can pause a task', async () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'tg:main',
      prompt: 'do work',
      schedule_type: 'once',
      schedule_value: '2026-05-01T10:30:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-05-01T10:30:00.000Z',
      status: 'active',
      created_at: '2026-05-01T10:00:00.000Z',
    });
    const server = await startDashboardServer({
      projectRoot: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      secret: 'secret',
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    try {
      const denied = await request(address.port, '/api/snapshot');
      expect(denied.status).toBe(401);

      const paused = await request(address.port, '/api/tasks/task-2/pause', {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
      });
      expect(paused.status).toBe(200);
      expect(getTaskById('task-2')?.status).toBe('paused');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
