import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return {
    ...actual,
    GROUPS_DIR: '/tmp/__replaced__',
  };
});

import * as configMod from '../../config.js';
import { _initTestDatabase } from '../../db/init.js';
import {
  createAgentGroup,
  getAgentGroupByFolder,
} from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { handleCreateAgent, slugify } from '../create-agent.js';
import { isMember } from '../agent-group-members.js';

let tmpDir: string;
let groupsDir: string;

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-createagent-'));
  groupsDir = path.join(tmpDir, 'groups');
  fs.mkdirSync(groupsDir, { recursive: true });
  (configMod as { GROUPS_DIR: string }).GROUPS_DIR = groupsDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('My Researcher')).toBe('my-researcher');
  });
  it('strips leading/trailing hyphens', () => {
    expect(slugify('!!Hi!!')).toBe('hi');
  });
  it('caps at 64 chars', () => {
    expect(slugify('a'.repeat(100)).length).toBe(64);
  });
  it('returns empty string when no [a-z0-9] chars', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('handleCreateAgent', () => {
  it('drops silently when caller group is unknown', async () => {
    await handleCreateAgent(
      {
        name: 'Researcher',
        instructions: null,
        folder: null,
        groupFolder: 'no-such-caller',
        isMain: true,
      },
      undefined,
    );
    expect(getAgentGroupByFolder('researcher')).toBeUndefined();
  });

  it('non-admin sender is denied (no row, no filesystem)', async () => {
    createAgentGroup({ name: 'Sub', folder: 'sub' });
    ensureUser({ id: 'telegram:rando', kind: 'telegram' });

    await handleCreateAgent(
      {
        name: 'Researcher',
        instructions: null,
        folder: null,
        groupFolder: 'sub',
        isMain: false,
      },
      'telegram:rando',
    );

    expect(getAgentGroupByFolder('researcher')).toBeUndefined();
    expect(fs.existsSync(path.join(groupsDir, 'researcher'))).toBe(false);
  });

  it('isMain fallback admits the call when sender is undefined', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });

    await handleCreateAgent(
      {
        name: 'Researcher',
        instructions: 'You are a research assistant',
        folder: null,
        groupFolder: 'main',
        isMain: true,
      },
      undefined,
    );

    const created = getAgentGroupByFolder('researcher');
    expect(created).toBeDefined();
    expect(created?.name).toBe('Researcher');
    expect(fs.existsSync(path.join(groupsDir, 'researcher', 'CLAUDE.md'))).toBe(true);
    expect(
      fs.readFileSync(path.join(groupsDir, 'researcher', 'CLAUDE.md'), 'utf-8'),
    ).toBe('You are a research assistant');
  });

  it('owner senderUserId can create agents from a non-main caller', async () => {
    createAgentGroup({ name: 'Sub', folder: 'sub' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

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
    // Sender is added as a member of the new group
    expect(isMember('telegram:owner', created!.id)).toBe(true);
  });

  it('global admin senderUserId is admitted', async () => {
    createAgentGroup({ name: 'Sub', folder: 'sub' });
    ensureUser({ id: 'telegram:gadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:gadmin', role: 'admin' });

    await handleCreateAgent(
      {
        name: 'Helper',
        instructions: null,
        folder: null,
        groupFolder: 'sub',
        isMain: false,
      },
      'telegram:gadmin',
    );

    expect(getAgentGroupByFolder('helper')).toBeDefined();
  });

  it('scoped admin of the parent agent group is admitted', async () => {
    const parent = createAgentGroup({ name: 'Sub', folder: 'sub' });
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    grantRole({
      user_id: 'telegram:scoped',
      role: 'admin',
      agent_group_id: parent.id,
    });

    await handleCreateAgent(
      {
        name: 'Helper',
        instructions: null,
        folder: null,
        groupFolder: 'sub',
        isMain: false,
      },
      'telegram:scoped',
    );

    expect(getAgentGroupByFolder('helper')).toBeDefined();
  });

  it('uses an explicit folder when provided', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });

    await handleCreateAgent(
      {
        name: 'Some Long Name',
        instructions: null,
        folder: 'short',
        groupFolder: 'main',
        isMain: true,
      },
      undefined,
    );

    expect(getAgentGroupByFolder('short')).toBeDefined();
    // The slugified-from-name folder should NOT have been used.
    expect(getAgentGroupByFolder('some-long-name')).toBeUndefined();
  });

  it('rejects a folder that does not match the safe regex', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });

    await handleCreateAgent(
      {
        name: 'Researcher',
        instructions: null,
        folder: '../escape',
        groupFolder: 'main',
        isMain: true,
      },
      undefined,
    );

    expect(getAgentGroupByFolder('researcher')).toBeUndefined();
    expect(fs.existsSync(path.join(groupsDir, 'researcher'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'escape'))).toBe(false);
  });

  it('rejects the reserved folder "global"', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });

    await handleCreateAgent(
      {
        name: 'Global',
        instructions: null,
        folder: 'global',
        groupFolder: 'main',
        isMain: true,
      },
      undefined,
    );

    // No new agent_groups row inserted for "global"
    expect(getAgentGroupByFolder('global')).toBeUndefined();
  });

  it('rejects a name that is too long', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });

    await handleCreateAgent(
      {
        name: 'a'.repeat(65),
        instructions: null,
        folder: null,
        groupFolder: 'main',
        isMain: true,
      },
      undefined,
    );

    expect(fs.readdirSync(groupsDir).length).toBe(0);
  });

  it('rejects a name that slugifies to empty', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });

    await handleCreateAgent(
      {
        name: '!!!',
        instructions: null,
        folder: null,
        groupFolder: 'main',
        isMain: true,
      },
      undefined,
    );

    expect(fs.readdirSync(groupsDir).length).toBe(0);
  });

  it('appends -2, -3, ... when the slugified folder collides', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });
    // Pre-existing agent occupies "researcher"
    createAgentGroup({ name: 'Existing', folder: 'researcher' });

    await handleCreateAgent(
      {
        name: 'Researcher',
        instructions: null,
        folder: null,
        groupFolder: 'main',
        isMain: true,
      },
      undefined,
    );

    expect(getAgentGroupByFolder('researcher-2')).toBeDefined();
    expect(fs.existsSync(path.join(groupsDir, 'researcher-2'))).toBe(true);
  });

  it('copies IDENTITY.md from groups/global/IDENTITY.md fallback', async () => {
    fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'IDENTITY.md'),
      '# Default Identity\n',
    );
    createAgentGroup({ name: 'Main', folder: 'main' });

    await handleCreateAgent(
      {
        name: 'Researcher',
        instructions: null,
        folder: null,
        groupFolder: 'main',
        isMain: true,
      },
      undefined,
    );

    const identity = path.join(groupsDir, 'researcher', 'IDENTITY.md');
    expect(fs.existsSync(identity)).toBe(true);
    expect(fs.readFileSync(identity, 'utf-8')).toBe('# Default Identity\n');
  });

  it('persists agent_provider via resolveProviderName (defaults to "claude")', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });

    await handleCreateAgent(
      {
        name: 'Researcher',
        instructions: null,
        folder: null,
        groupFolder: 'main',
        isMain: true,
      },
      undefined,
    );

    const created = getAgentGroupByFolder('researcher');
    expect(created?.agent_provider).toBe('claude');
  });
});
