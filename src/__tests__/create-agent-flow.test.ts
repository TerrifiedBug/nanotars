/**
 * Phase 5E — end-to-end `create_agent` IPC flow.
 *
 * Drives `processTaskIpc` directly with a `create_agent` payload and
 * asserts the full chain produces a new `agent_groups` row, scaffolds the
 * filesystem, and returns to the standard idle state. Negative paths
 * (non-admin sender, invalid folder) verify nothing is written.
 *
 * Deliberately skips card delivery / notifyAgent assertions — that path
 * is a logger.warn stub today (see `permissions/approval-primitive.ts`)
 * and will be wired in a follow-on task. Once notifyAgent gains a real
 * delivery hook, swap the logger.warn assertions in for explicit
 * delivery-route assertions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    GROUPS_DIR: '/tmp/__replaced__',
  };
});

import * as configMod from '../config.js';
import { _initTestDatabase } from '../db/init.js';
import {
  createAgentGroup,
  getAgentGroupByFolder,
} from '../db/agent-groups.js';
import { processTaskIpc } from '../ipc/tasks.js';
import { ensureUser } from '../permissions/users.js';
import { grantRole } from '../permissions/user-roles.js';
import { isMember } from '../permissions/agent-group-members.js';
import type { IpcDeps } from '../ipc/types.js';

let tmpDir: string;
let groupsDir: string;

function makeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: vi.fn(),
    sendFile: vi.fn(async () => true),
    react: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    syncGroupMetadata: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-createflow-'));
  groupsDir = path.join(tmpDir, 'groups');
  fs.mkdirSync(groupsDir, { recursive: true });
  (configMod as { GROUPS_DIR: string }).GROUPS_DIR = groupsDir;
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('processTaskIpc: create_agent end-to-end', () => {
  it('admin creates a new agent group + filesystem scaffold + member row', async () => {
    // Caller is the main agent group (admin route via isMain fallback)
    const callerAg = createAgentGroup({ name: 'Main', folder: 'main' });
    expect(callerAg).toBeDefined();

    // groups/global/IDENTITY.md fallback so the new agent gets a default
    // identity copied in.
    fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'IDENTITY.md'),
      '# Default Identity\n',
    );

    await processTaskIpc(
      {
        type: 'create_agent',
        name: 'Researcher',
        instructions: 'You are a research assistant',
        folder: null,
        timestamp: '2026-04-26T12:00:00.000Z',
      },
      'main', // sourceGroup (verified IPC directory identity)
      true, // isMain
      makeDeps(),
    );

    // 1. New agent_groups row exists with the expected folder.
    const created = getAgentGroupByFolder('researcher');
    expect(created).toBeDefined();
    expect(created?.name).toBe('Researcher');
    expect(created?.folder).toBe('researcher');

    // 2. groups/researcher/CLAUDE.md was written with the instructions.
    const claudeMd = path.join(groupsDir, 'researcher', 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(true);
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe(
      'You are a research assistant',
    );

    // 3. groups/researcher/IDENTITY.md was copied from global fallback.
    const identity = path.join(groupsDir, 'researcher', 'IDENTITY.md');
    expect(fs.existsSync(identity)).toBe(true);
    expect(fs.readFileSync(identity, 'utf-8')).toBe('# Default Identity\n');

    // 4. agent_provider was persisted via resolveProviderName.
    expect(created?.agent_provider).toBe('claude');
  });

  it('admin sender (with senderUserId-equivalent path via grantRole+isMain) produces member row', async () => {
    // Path: senderUserId is undefined on the IPC layer (v1-archive gap),
    // so the handler falls back to isMain. Member row only attaches when
    // senderUserId is non-undefined; verify behaviour by exercising the
    // direct handler with a real sender below.
    const callerAg = createAgentGroup({ name: 'Sub', folder: 'sub' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    // Use the handler directly (mirrors what processTaskIpc would do once
    // sender threading is complete) so we can assert the member row.
    const { handleCreateAgent } = await import(
      '../permissions/create-agent.js'
    );
    await handleCreateAgent(
      {
        name: 'Helper',
        instructions: null,
        folder: null,
        groupFolder: 'sub',
        isMain: false,
      },
      'telegram:owner',
    );

    const created = getAgentGroupByFolder('helper');
    expect(created).toBeDefined();
    expect(created?.id).not.toBe(callerAg.id);
    expect(isMember('telegram:owner', created!.id)).toBe(true);
  });

  it('non-main IPC source without sender threading is denied (legacy isMain fallback)', async () => {
    createAgentGroup({ name: 'Sub', folder: 'sub' });

    await processTaskIpc(
      {
        type: 'create_agent',
        name: 'Researcher',
        instructions: 'You are a research assistant',
        folder: null,
        timestamp: '2026-04-26T12:00:00.000Z',
      },
      'sub', // sourceGroup
      false, // isMain=false → denied via fallback
      makeDeps(),
    );

    expect(getAgentGroupByFolder('researcher')).toBeUndefined();
    expect(fs.existsSync(path.join(groupsDir, 'researcher'))).toBe(false);
  });

  it('caller group not in DB → drop silently', async () => {
    // No createAgentGroup call → 'main' folder has no row.
    await processTaskIpc(
      {
        type: 'create_agent',
        name: 'Researcher',
        instructions: null,
        folder: null,
        timestamp: '2026-04-26T12:00:00.000Z',
      },
      'main',
      true,
      makeDeps(),
    );

    expect(getAgentGroupByFolder('researcher')).toBeUndefined();
  });

  it('explicit folder + uniqueness suffix on collision', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });
    // Pre-existing agent occupies the explicit folder.
    createAgentGroup({ name: 'Existing', folder: 'researcher' });

    await processTaskIpc(
      {
        type: 'create_agent',
        name: 'New Researcher',
        instructions: 'Hello',
        folder: 'researcher',
        timestamp: '2026-04-26T12:00:00.000Z',
      },
      'main',
      true,
      makeDeps(),
    );

    expect(getAgentGroupByFolder('researcher-2')).toBeDefined();
    expect(fs.existsSync(path.join(groupsDir, 'researcher-2'))).toBe(true);
  });

  it('invalid folder is rejected — no row, no filesystem entry', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });

    await processTaskIpc(
      {
        type: 'create_agent',
        name: 'Researcher',
        instructions: null,
        folder: '../escape',
        timestamp: '2026-04-26T12:00:00.000Z',
      },
      'main',
      true,
      makeDeps(),
    );

    expect(getAgentGroupByFolder('researcher')).toBeUndefined();
    expect(fs.existsSync(path.join(groupsDir, 'researcher'))).toBe(false);
    // Sanity: ensure escape candidate didn't land in tmpDir's parent.
    expect(fs.existsSync(path.join(tmpDir, 'escape'))).toBe(false);
  });

  it('omitted instructions → no CLAUDE.md is written', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });

    await processTaskIpc(
      {
        type: 'create_agent',
        name: 'Researcher',
        instructions: null,
        folder: null,
        timestamp: '2026-04-26T12:00:00.000Z',
      },
      'main',
      true,
      makeDeps(),
    );

    expect(getAgentGroupByFolder('researcher')).toBeDefined();
    expect(
      fs.existsSync(path.join(groupsDir, 'researcher', 'CLAUDE.md')),
    ).toBe(false);
  });
});
