import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/__replaced__',
  GROUPS_DIR: '/tmp/__replaced__',
  IPC_POLL_INTERVAL: 100,
  MAIN_GROUP_FOLDER: 'main',
  TIMEZONE: 'UTC',
}));

vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));

import type { IpcDeps } from './ipc.js';
import * as configMod from './config.js';
import { getTaskById, updateTask } from './db.js';
import type { RegisteredGroup } from './types.js';

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
    const { startIpcWatcher } = await import('./ipc.js');

    const deps = makeDeps();
    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, 'msg-1.json'),
      JSON.stringify({ type: 'message', chatJid: 'jid@test', text: 'hello' }),
    );

    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).toHaveBeenCalledWith('jid@test', 'hello', undefined, undefined);
    expect(fs.existsSync(path.join(ipcDir, 'msg-1.json'))).toBe(false);
  });

  it('moves broken JSON to errors directory', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('./ipc.js');

    const deps = makeDeps();
    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(path.join(ipcDir, 'bad.json'), 'not json{{{');

    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(fs.existsSync(path.join(ipcDir, 'bad.json'))).toBe(false);
    const errDir = path.join(tmpDir, 'ipc', 'errors');
    expect(fs.existsSync(errDir)).toBe(true);
    const errFiles = fs.readdirSync(errDir);
    expect(errFiles).toHaveLength(1);
    expect(errFiles[0]).toContain('main-bad.json');
  });

  it('processes react messages', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('./ipc.js');

    const deps = makeDeps();
    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, 'react-1.json'),
      JSON.stringify({ type: 'react', chatJid: 'jid@test', messageId: 'mid', emoji: '👍' }),
    );

    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.react).toHaveBeenCalledWith('jid@test', 'mid', '👍');
  });

  it('blocks unauthorized messages from non-main groups', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('./ipc.js');

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

    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('skips non-json files', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('./ipc.js');

    const deps = makeDeps();
    const ipcDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(path.join(ipcDir, 'readme.txt'), 'not a message');

    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ipcDir, 'readme.txt'))).toBe(true);
  });
});

// --- startIpcWatcher: send_file ---

describe('startIpcWatcher: send_file', () => {
  it('translates container path to host path and sends', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('./ipc.js');

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

    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendFile).toHaveBeenCalled();
    const call = vi.mocked(deps.sendFile).mock.calls[0];
    expect(call[0]).toBe('jid@test');
    expect(call[2]).toBe('image/png');
    expect(call[3]).toBe('photo.png');
  });

  it('warns when file does not exist', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('./ipc.js');

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

    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendFile).not.toHaveBeenCalled();
  });

  it('infers MIME type from extension', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('./ipc.js');

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

    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendFile).toHaveBeenCalled();
    const call = vi.mocked(deps.sendFile).mock.calls[0];
    expect(call[2]).toBe('application/pdf');
  });

  it('uses custom fileName when provided', async () => {
    vi.resetModules();
    const { startIpcWatcher } = await import('./ipc.js');

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

    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendFile).toHaveBeenCalled();
    const call = vi.mocked(deps.sendFile).mock.calls[0];
    expect(call[3]).toBe('report.csv');
  });
});

// --- processTaskIpc: update_task schedule recomputation ---

describe('processTaskIpc: update_task', () => {
  let processTaskIpc: typeof import('./ipc.js').processTaskIpc;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./ipc.js');
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
});
