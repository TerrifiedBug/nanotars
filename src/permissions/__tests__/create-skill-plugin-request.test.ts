/**
 * Slice 6 — host-side request flow for `create_skill_plugin`.
 *
 * Covers the full validation surface (every rule from the spec), the
 * filesystem-uniqueness check (rejects when plugins/{name}/ already exists),
 * and the requestApproval round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { _initTestDatabase } from '../../db/init.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import {
  clearApprovalHandlers,
  getPendingApproval,
} from '../approval-primitive.js';
import {
  handleCreateSkillPluginRequest,
  registerCreateSkillPluginHandler,
  type CreateSkillPluginRequestTask,
} from '../create-skill-plugin.js';

let tmpProjectRoot: string;
let originalCwd: string;

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
  registerCreateSkillPluginHandler();
  tmpProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-test-'));
  fs.mkdirSync(path.join(tmpProjectRoot, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(tmpProjectRoot, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(tmpProjectRoot, 'groups', 'main'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(tmpProjectRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpProjectRoot, { recursive: true, force: true });
});

async function setupGroupWithApprover(folder = 'main') {
  ensureUser({ id: 'telegram:owner', kind: 'telegram' });
  grantRole({ user_id: 'telegram:owner', role: 'owner' });
  await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
  return createAgentGroup({ name: folder, folder });
}

function validTask(overrides: Partial<CreateSkillPluginRequestTask> = {}): CreateSkillPluginRequestTask {
  return {
    name: 'weather',
    description: 'Look up weather forecasts',
    archetype: 'skill-only',
    pluginJson: {
      name: 'weather',
      description: 'Look up weather forecasts',
      version: '1.0.0',
      channels: ['*'],
      groups: ['*'],
    },
    containerSkillMd: '# Weather\n\nUse curl to fetch from wttr.in',
    groupFolder: 'main',
    ...overrides,
  };
}

describe('handleCreateSkillPluginRequest', () => {
  it('happy path: queues a pending_approvals row with full payload', async () => {
    const ag = await setupGroupWithApprover();
    const approvalId = await handleCreateSkillPluginRequest(validTask({ groupFolder: ag.folder }), 'telegram');
    expect(approvalId).toBeTruthy();
    const row = getPendingApproval(approvalId!);
    expect(row!.action).toBe('create_skill_plugin');
    expect(row!.title).toBe('Create Skill Plugin Request');
    const payload = JSON.parse(row!.payload as string);
    expect(payload.name).toBe('weather');
    expect(payload.archetype).toBe('skill-only');
  });

  it('drops when agent group does not exist', async () => {
    await setupGroupWithApprover();
    const approvalId = await handleCreateSkillPluginRequest(
      validTask({ groupFolder: 'does-not-exist' }),
      'telegram',
    );
    expect(approvalId).toBeUndefined();
  });

  it('rejects invalid name', async () => {
    const ag = await setupGroupWithApprover();
    const approvalId = await handleCreateSkillPluginRequest(
      validTask({ name: 'Weather', groupFolder: ag.folder }),
      'telegram',
    );
    expect(approvalId).toBeUndefined();
  });

  it('rejects archetype outside skill-only/mcp', async () => {
    const ag = await setupGroupWithApprover();
    const approvalId = await handleCreateSkillPluginRequest(
      // @ts-expect-error testing runtime guard
      validTask({ archetype: 'host-hook', groupFolder: ag.folder }),
      'telegram',
    );
    expect(approvalId).toBeUndefined();
  });

  it('rejects pluginJson.hooks non-empty', async () => {
    const ag = await setupGroupWithApprover();
    const task = validTask({ groupFolder: ag.folder });
    (task.pluginJson as Record<string, unknown>).hooks = ['onStartup'];
    const approvalId = await handleCreateSkillPluginRequest(task, 'telegram');
    expect(approvalId).toBeUndefined();
  });

  it('rejects pluginJson.containerHooks non-empty', async () => {
    const ag = await setupGroupWithApprover();
    const task = validTask({ groupFolder: ag.folder });
    (task.pluginJson as Record<string, unknown>).containerHooks = ['hooks/x.js'];
    const approvalId = await handleCreateSkillPluginRequest(task, 'telegram');
    expect(approvalId).toBeUndefined();
  });

  it('rejects pluginJson.dependencies = true', async () => {
    const ag = await setupGroupWithApprover();
    const task = validTask({ groupFolder: ag.folder });
    (task.pluginJson as Record<string, unknown>).dependencies = true;
    const approvalId = await handleCreateSkillPluginRequest(task, 'telegram');
    expect(approvalId).toBeUndefined();
  });

  it('rejects when plugins/{name}/ already exists (uniqueness)', async () => {
    const ag = await setupGroupWithApprover();
    fs.mkdirSync(path.join(tmpProjectRoot, 'plugins', 'weather'));
    const approvalId = await handleCreateSkillPluginRequest(
      validTask({ groupFolder: ag.folder }),
      'telegram',
    );
    expect(approvalId).toBeUndefined();
  });

  it('rejects when .claude/skills/add-skill-{name}/ already exists', async () => {
    const ag = await setupGroupWithApprover();
    fs.mkdirSync(path.join(tmpProjectRoot, '.claude', 'skills', 'add-skill-weather'), {
      recursive: true,
    });
    const approvalId = await handleCreateSkillPluginRequest(
      validTask({ groupFolder: ag.folder }),
      'telegram',
    );
    expect(approvalId).toBeUndefined();
  });

  it('rejects reserved env var names', async () => {
    const ag = await setupGroupWithApprover();
    const approvalId = await handleCreateSkillPluginRequest(
      validTask({ groupFolder: ag.folder, envVarValues: { ANTHROPIC_API_KEY: 'x' } }),
      'telegram',
    );
    expect(approvalId).toBeUndefined();
  });

  it('rejects reserved env var prefix', async () => {
    const ag = await setupGroupWithApprover();
    const approvalId = await handleCreateSkillPluginRequest(
      validTask({ groupFolder: ag.folder, envVarValues: { NANOCLAW_X: 'y' } }),
      'telegram',
    );
    expect(approvalId).toBeUndefined();
  });

  it('rejects groups scope that includes a different group folder', async () => {
    const ag = await setupGroupWithApprover('main');
    const task = validTask({ groupFolder: ag.folder });
    task.pluginJson.groups = ['other'];
    const approvalId = await handleCreateSkillPluginRequest(task, 'telegram');
    expect(approvalId).toBeUndefined();
  });

  it('accepts groups = [originating folder]', async () => {
    const ag = await setupGroupWithApprover('main');
    const task = validTask({ groupFolder: ag.folder });
    task.pluginJson.groups = ['main'];
    const approvalId = await handleCreateSkillPluginRequest(task, 'telegram');
    expect(approvalId).toBeTruthy();
  });
});
