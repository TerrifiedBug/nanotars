import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  DATA_DIR: '/tmp/__replaced__',
  GROUPS_DIR: '/tmp/__replaced__',
  IPC_POLL_INTERVAL: 100,
  MAIN_GROUP_FOLDER: 'main',
  TIMEZONE: 'UTC',
}));

vi.mock('../../db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));

import type { IpcDeps } from '../index.js';
import * as configMod from '../../config.js';
import { createTask, getTaskById, updateTask } from '../../db.js';
import { logger } from '../../logger.js';
import type { RegisteredGroup } from '../../types.js';

let tmpDir: string;

function makeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: vi.fn(),
    sendFile: vi.fn(async () => true),
    react: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'jid@test': { name: 'Main', folder: 'main', trigger: '@TARS', added_at: '2024-01-01' } as RegisteredGroup,
    })),
    registerGroup: vi.fn(),
    syncGroupMetadata: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-test-'));
  (configMod as any).DATA_DIR = tmpDir;
  (configMod as any).GROUPS_DIR = path.join(tmpDir, 'groups');
  fs.mkdirSync(path.join(tmpDir, 'groups', 'main'), { recursive: true });
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- startIpcWatcher: use resetModules for each test to get fresh ipcWatcherRunning ---

describe('startIpcWatcher', () => {
  it('processes message files and deletes them', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps();
    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, 'msg-1.json'),
      JSON.stringify({ type: 'message', chatJid: 'jid@test', text: 'hello' }),
    );

    await startIpcWatcher(deps);

    expect(deps.sendMessage).toHaveBeenCalledWith('jid@test', 'hello', undefined, undefined);
    expect(fs.existsSync(path.join(ipcDir, 'msg-1.json'))).toBe(false);
  });

  it('moves broken JSON to errors directory', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps();
    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(path.join(ipcDir, 'bad.json'), 'not json{{{');

    await startIpcWatcher(deps);

    expect(fs.existsSync(path.join(ipcDir, 'bad.json'))).toBe(false);
    const errDir = path.join(tmpDir, 'ipc', 'errors');
    expect(fs.existsSync(errDir)).toBe(true);
    const errFiles = fs.readdirSync(errDir);
    expect(errFiles).toHaveLength(1);
    expect(errFiles[0]).toContain('main-bad.json');
  });

  it('processes react messages', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps();
    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, 'react-1.json'),
      JSON.stringify({ type: 'react', chatJid: 'jid@test', messageId: 'mid', emoji: '👍' }),
    );

    await startIpcWatcher(deps);

    expect(deps.react).toHaveBeenCalledWith('jid@test', 'mid', '👍');
  });

  it('blocks unauthorized messages from non-main groups', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps({
      registeredGroups: vi.fn(() => ({
        'jid@test': { name: 'Main', folder: 'main', trigger: '@TARS', added_at: '2024-01-01' } as RegisteredGroup,
      })),
    });
    const ipcDir = path.join(tmpDir, 'ipc', 'other-group', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, 'msg-1.json'),
      JSON.stringify({ type: 'message', chatJid: 'jid@test', text: 'attack' }),
    );

    await startIpcWatcher(deps);

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('skips non-json files', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps();
    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(path.join(ipcDir, 'readme.txt'), 'not a message');

    await startIpcWatcher(deps);

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ipcDir, 'readme.txt'))).toBe(true);
  });
});

// --- startIpcWatcher: send_file ---

describe('startIpcWatcher: send_file', () => {
  it('translates container path to host path and sends', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps();
    const groupDir = path.join(tmpDir, 'groups', 'main');
    const mediaDir = path.join(groupDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'photo.png'), 'fake-png');

    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, 'file-1.json'),
      JSON.stringify({
        type: 'send_file',
        chatJid: 'jid@test',
        filePath: '/workspace/group/media/photo.png',
      }),
    );

    await startIpcWatcher(deps);

    expect(deps.sendFile).toHaveBeenCalled();
    const call = vi.mocked(deps.sendFile).mock.calls[0];
    expect(call[0]).toBe('jid@test');
    expect(call[2]).toBe('image/png');
    expect(call[3]).toBe('photo.png');
  });

  it('warns when file does not exist', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps();
    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, 'file-1.json'),
      JSON.stringify({
        type: 'send_file',
        chatJid: 'jid@test',
        filePath: '/nonexistent/file.txt',
      }),
    );

    await startIpcWatcher(deps);

    expect(deps.sendFile).not.toHaveBeenCalled();
  });

  it('infers MIME type from extension', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps();
    const dir = path.join(tmpDir, 'groups', 'main', 'docs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.pdf'), 'fake-pdf');

    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, 'file-1.json'),
      JSON.stringify({
        type: 'send_file',
        chatJid: 'jid@test',
        filePath: '/workspace/group/docs/report.pdf',
      }),
    );

    await startIpcWatcher(deps);

    expect(deps.sendFile).toHaveBeenCalled();
    const call = vi.mocked(deps.sendFile).mock.calls[0];
    expect(call[2]).toBe('application/pdf');
  });

  it('uses custom fileName when provided', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps();
    const dir = path.join(tmpDir, 'groups', 'main');
    fs.writeFileSync(path.join(dir, 'data.csv'), 'a,b,c');

    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, 'file-1.json'),
      JSON.stringify({
        type: 'send_file',
        chatJid: 'jid@test',
        filePath: '/workspace/group/data.csv',
        fileName: 'report.csv',
      }),
    );

    await startIpcWatcher(deps);

    expect(deps.sendFile).toHaveBeenCalled();
    const call = vi.mocked(deps.sendFile).mock.calls[0];
    expect(call[3]).toBe('report.csv');
  });
});

// --- processTaskIpc: update_task schedule recomputation ---

describe('processTaskIpc: update_task', () => {
  let processTaskIpc: typeof import('../index.js').processTaskIpc;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../index.js');
    processTaskIpc = mod.processTaskIpc;
  });

  function makeTask(overrides = {}) {
    return {
      id: 't1', group_folder: 'main', chat_jid: 'jid@test', prompt: 'x',
      schedule_type: 'cron' as const, schedule_value: '0 9 * * *', context_mode: 'isolated' as const,
      model: null, next_run: null, last_run: null, last_result: null, status: 'active' as const, created_at: '',
      ...overrides,
    };
  }

  it('updates prompt', async () => {
    vi.mocked(getTaskById).mockReturnValue(makeTask());
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'update_task', taskId: 't1', prompt: 'new prompt' },
      'main', true, deps,
    );

    expect(updateTask).toHaveBeenCalledWith('t1', expect.objectContaining({ prompt: 'new prompt' }));
  });

  it('updates model', async () => {
    vi.mocked(getTaskById).mockReturnValue(makeTask());
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'update_task', taskId: 't1', model: 'opus' },
      'main', true, deps,
    );

    expect(updateTask).toHaveBeenCalledWith('t1', expect.objectContaining({ model: 'opus' }));
  });

  it('recomputes next_run for cron schedule change', async () => {
    vi.mocked(getTaskById).mockReturnValue(makeTask());
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'update_task', taskId: 't1', schedule_type: 'cron', schedule_value: '0 12 * * *' },
      'main', true, deps,
    );

    expect(updateTask).toHaveBeenCalled();
    const updates = vi.mocked(updateTask).mock.calls[0][1] as any;
    expect(updates.schedule_type).toBe('cron');
    expect(updates.next_run).toBeDefined();
    expect(new Date(updates.next_run).getTime()).not.toBeNaN();
  });

  it('recomputes next_run for interval schedule change', async () => {
    vi.mocked(getTaskById).mockReturnValue(makeTask());
    const deps = makeDeps();
    const now = Date.now();
    vi.setSystemTime(now);

    await processTaskIpc(
      { type: 'update_task', taskId: 't1', schedule_type: 'interval', schedule_value: '60000' },
      'main', true, deps,
    );

    const updates = vi.mocked(updateTask).mock.calls[0][1] as any;
    const nextRunMs = new Date(updates.next_run).getTime();
    expect(nextRunMs).toBe(now + 60000);
  });

  it('recomputes next_run for once schedule change', async () => {
    vi.mocked(getTaskById).mockReturnValue(makeTask());
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'update_task', taskId: 't1', schedule_type: 'once', schedule_value: '2030-06-15T12:00:00.000Z' },
      'main', true, deps,
    );

    const updates = vi.mocked(updateTask).mock.calls[0][1] as any;
    expect(updates.next_run).toBe('2030-06-15T12:00:00.000Z');
  });

  it('rejects invalid cron expression', async () => {
    vi.mocked(getTaskById).mockReturnValue(makeTask());
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'update_task', taskId: 't1', schedule_type: 'cron', schedule_value: 'not valid cron' },
      'main', true, deps,
    );

    expect(updateTask).not.toHaveBeenCalled();
  });

  it('rejects invalid interval value', async () => {
    vi.mocked(getTaskById).mockReturnValue(makeTask());
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'update_task', taskId: 't1', schedule_type: 'interval', schedule_value: '-1' },
      'main', true, deps,
    );

    expect(updateTask).not.toHaveBeenCalled();
  });

  it('rejects invalid once timestamp', async () => {
    vi.mocked(getTaskById).mockReturnValue(makeTask());
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'update_task', taskId: 't1', schedule_type: 'once', schedule_value: 'not-a-date' },
      'main', true, deps,
    );

    expect(updateTask).not.toHaveBeenCalled();
  });

  it('blocks non-main group from updating another groups task', async () => {
    vi.mocked(getTaskById).mockReturnValue(makeTask());
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'update_task', taskId: 't1', prompt: 'hacked' },
      'other-group', false, deps,
    );

    expect(updateTask).not.toHaveBeenCalled();
  });

  it('ignores empty/whitespace-only prompt', async () => {
    vi.mocked(getTaskById).mockReturnValue(makeTask());
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'update_task', taskId: 't1', prompt: '   ' },
      'main', true, deps,
    );

    expect(updateTask).toHaveBeenCalled();
    const updates = vi.mocked(updateTask).mock.calls[0][1] as any;
    expect(updates.prompt).toBeUndefined();
  });

  it('rejects invalid schedule_type in update_task', async () => {
    vi.mocked(getTaskById).mockReturnValue(makeTask());
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'update_task', taskId: 't1', schedule_type: 'bogus', schedule_value: '123' },
      'main', true, deps,
    );

    expect(updateTask).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleType: 'bogus' }),
      expect.stringContaining('Invalid schedule_type'),
    );
  });
});

// --- isValidTaskIpc: unknown/missing task type quarantined ---

describe('startIpcWatcher: task type validation', () => {
  it('quarantines task file with unknown type', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps();
    const tasksDir = path.join(tmpDir, 'ipc', 'main', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, 'bad-type.json'),
      JSON.stringify({ type: 'hack_the_planet', payload: 'evil' }),
    );

    await startIpcWatcher(deps);

    // Original file should be gone
    expect(fs.existsSync(path.join(tasksDir, 'bad-type.json'))).toBe(false);
    // Should be in errors directory
    const errDir = path.join(tmpDir, 'ipc', 'errors');
    expect(fs.existsSync(errDir)).toBe(true);
    const errFiles = fs.readdirSync(errDir);
    expect(errFiles.some((f) => f.includes('bad-type.json'))).toBe(true);
  });

  it('quarantines task file with missing type field', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps();
    const tasksDir = path.join(tmpDir, 'ipc', 'main', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, 'no-type.json'),
      JSON.stringify({ prompt: 'do something', schedule_value: '60000' }),
    );

    await startIpcWatcher(deps);

    expect(fs.existsSync(path.join(tasksDir, 'no-type.json'))).toBe(false);
    const errDir = path.join(tmpDir, 'ipc', 'errors');
    const errFiles = fs.readdirSync(errDir);
    expect(errFiles.some((f) => f.includes('no-type.json'))).toBe(true);
  });

  it('processes valid task types normally', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('../index.js');

    const deps = makeDeps();
    const tasksDir = path.join(tmpDir, 'ipc', 'main', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, 'valid-task.json'),
      JSON.stringify({
        type: 'schedule_task',
        prompt: 'test',
        schedule_type: 'interval',
        schedule_value: '60000',
        targetJid: 'jid@test',
      }),
    );

    await startIpcWatcher(deps);

    // File should be processed and deleted (not quarantined)
    expect(fs.existsSync(path.join(tasksDir, 'valid-task.json'))).toBe(false);
    const errDir = path.join(tmpDir, 'ipc', 'errors');
    if (fs.existsSync(errDir)) {
      const errFiles = fs.readdirSync(errDir);
      expect(errFiles.some((f) => f.includes('valid-task.json'))).toBe(false);
    }
    // Task should have been created
    expect(createTask).toHaveBeenCalled();
  });
});

// --- processTaskIpc: schedule_type validation ---

describe('processTaskIpc: schedule_type validation', () => {
  let processTaskIpc: typeof import('../index.js').processTaskIpc;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../index.js');
    processTaskIpc = mod.processTaskIpc;
  });

  it('rejects invalid schedule_type in schedule_task', async () => {
    const deps = makeDeps();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'test',
        schedule_type: 'weekly',
        schedule_value: '60000',
        targetJid: 'jid@test',
      },
      'main', true, deps,
    );

    expect(createTask).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleType: 'weekly' }),
      expect.stringContaining('Invalid schedule_type'),
    );
  });

  it('accepts valid schedule_type cron', async () => {
    const deps = makeDeps();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'test cron',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'jid@test',
      },
      'main', true, deps,
    );

    expect(createTask).toHaveBeenCalled();
  });

  it('accepts valid schedule_type once', async () => {
    const deps = makeDeps();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'test once',
        schedule_type: 'once',
        schedule_value: '2030-06-15T12:00:00Z',
        targetJid: 'jid@test',
      },
      'main', true, deps,
    );

    expect(createTask).toHaveBeenCalled();
  });
});
