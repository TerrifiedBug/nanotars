import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../config.js', () => ({
  DATA_DIR: '/tmp/__will_be_replaced__',
}));

import {
  mapAgentGroupsToSnapshot,
  mapTasksToSnapshot,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../snapshots.js';
import * as configMod from '../config.js';
import {
  _initTestDatabase,
  createAgentGroup,
  createMessagingGroup,
  createWiring,
} from '../db/index.js';
import type { ScheduledTask } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-snap-test-'));
  // Point DATA_DIR to temp directory
  (configMod as { DATA_DIR: string }).DATA_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'main',
    chat_jid: 'jid@test',
    prompt: 'do stuff',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    model: null,
    next_run: '2026-01-01T09:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- mapTasksToSnapshot ---

describe('mapTasksToSnapshot', () => {
  it('maps task DB rows to snapshot format', () => {
    const task = makeTask({ id: 'task-42', model: 'opus' });
    const result = mapTasksToSnapshot([task]);
    expect(result).toEqual([{
      id: 'task-42',
      groupFolder: 'main',
      prompt: 'do stuff',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      status: 'active',
      next_run: '2026-01-01T09:00:00.000Z',
      model: 'opus',
    }]);
  });

  it('returns empty array for empty input', () => {
    expect(mapTasksToSnapshot([])).toEqual([]);
  });

  it('handles null model and next_run', () => {
    const task = makeTask({ model: null, next_run: null });
    const result = mapTasksToSnapshot([task]);
    expect(result[0].model).toBeNull();
    expect(result[0].next_run).toBeNull();
  });
});

// --- writeTasksSnapshot ---

describe('writeTasksSnapshot', () => {
  const tasks = [
    { id: 't1', groupFolder: 'main', prompt: 'a', schedule_type: 'cron', schedule_value: '* * * * *', status: 'active', next_run: null, model: null },
    { id: 't2', groupFolder: 'family', prompt: 'b', schedule_type: 'once', schedule_value: '2026-01-01', status: 'active', next_run: null, model: null },
  ];

  it('main group sees all tasks', () => {
    writeTasksSnapshot('main', true, tasks);
    const file = path.join(tmpDir, 'ipc', 'main', 'current_tasks.json');
    const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(written).toHaveLength(2);
  });

  it('non-main group sees only its own tasks', () => {
    writeTasksSnapshot('family', false, tasks);
    const file = path.join(tmpDir, 'ipc', 'family', 'current_tasks.json');
    const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('t2');
  });

  it('creates IPC directory if it does not exist', () => {
    writeTasksSnapshot('newgroup', false, []);
    expect(fs.existsSync(path.join(tmpDir, 'ipc', 'newgroup'))).toBe(true);
  });

  it('writes valid JSON', () => {
    writeTasksSnapshot('main', true, tasks);
    const file = path.join(tmpDir, 'ipc', 'main', 'current_tasks.json');
    expect(() => JSON.parse(fs.readFileSync(file, 'utf-8'))).not.toThrow();
  });

  it('does not leave .tmp file after atomic write', () => {
    const groupFolder = 'test-group';
    const tasksData = [{ id: '1', groupFolder, prompt: 'test', schedule_type: 'once', schedule_value: '2026-01-01', status: 'active', next_run: null }];
    writeTasksSnapshot(groupFolder, true, tasksData);

    const tasksFile = path.join(tmpDir, 'ipc', groupFolder, 'current_tasks.json');
    expect(fs.existsSync(tasksFile)).toBe(true);
    expect(fs.existsSync(tasksFile + '.tmp')).toBe(false);
  });
});

// --- writeGroupsSnapshot ---

describe('writeGroupsSnapshot', () => {
  const groups = [
    { jid: 'g1@test', name: 'Group 1', lastActivity: '2026-01-01', isRegistered: true },
    { jid: 'g2@test', name: 'Group 2', lastActivity: '2026-01-02', isRegistered: false },
  ];
  const registeredJids = new Set(['g1@test']);

  it('main group sees all groups', () => {
    writeGroupsSnapshot('main', true, groups, registeredJids);
    const file = path.join(tmpDir, 'ipc', 'main', 'available_groups.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(data.groups).toHaveLength(2);
    expect(data.lastSync).toBeDefined();
  });

  it('non-main group sees empty groups array', () => {
    writeGroupsSnapshot('family', false, groups, registeredJids);
    const file = path.join(tmpDir, 'ipc', 'family', 'available_groups.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(data.groups).toHaveLength(0);
  });

  it('creates IPC directory if it does not exist', () => {
    writeGroupsSnapshot('newgroup', true, [], new Set());
    expect(fs.existsSync(path.join(tmpDir, 'ipc', 'newgroup'))).toBe(true);
  });

  it('includes lastSync timestamp', () => {
    writeGroupsSnapshot('main', true, [], new Set());
    const file = path.join(tmpDir, 'ipc', 'main', 'available_groups.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(new Date(data.lastSync).getTime()).not.toBeNaN();
  });
});

// --- mapAgentGroupsToSnapshot (Phase 4A: source from new entity-model tables) ---

describe('mapAgentGroupsToSnapshot', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('returns empty array when no agent groups exist', () => {
    expect(mapAgentGroupsToSnapshot()).toEqual([]);
  });

  it('produces one row per (agent, wiring) pair sourced from the entity model', () => {
    const ag = createAgentGroup({ name: 'Family', folder: 'family' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'fam@g.us',
      name: 'Family Chat',
    });
    createWiring({
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '@TARS',
    });

    const out = mapAgentGroupsToSnapshot();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      jid: 'fam@g.us',
      name: 'Family Chat',
      isRegistered: true,
    });
    expect(out[0].lastActivity).toBeDefined();
  });

  it('emits one row per wiring for multi-wiring agent groups', () => {
    const ag = createAgentGroup({ name: 'Multi', folder: 'multi' });
    const mg1 = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'a@g.us',
      name: 'Chat A',
    });
    const mg2 = createMessagingGroup({
      channel_type: 'discord',
      platform_id: 'dc:1',
      name: 'Chat B',
    });
    createWiring({ messaging_group_id: mg1.id, agent_group_id: ag.id });
    createWiring({ messaging_group_id: mg2.id, agent_group_id: ag.id });

    const out = mapAgentGroupsToSnapshot();
    expect(out).toHaveLength(2);
    const jids = out.map((r) => r.jid).sort();
    expect(jids).toEqual(['a@g.us', 'dc:1']);
  });

  it('falls back to agent_group.name when messaging_group.name is null', () => {
    const ag = createAgentGroup({ name: 'Agent Display Name', folder: 'noname' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'noname@g.us',
      name: null,
    });
    createWiring({ messaging_group_id: mg.id, agent_group_id: ag.id });

    const out = mapAgentGroupsToSnapshot();
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Agent Display Name');
  });

  it('skips agent groups with no wirings', () => {
    createAgentGroup({ name: 'Orphan', folder: 'orphan' });
    expect(mapAgentGroupsToSnapshot()).toEqual([]);
  });
});
