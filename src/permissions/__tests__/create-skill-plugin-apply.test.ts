/**
 * Slice 6 — host-side apply path for `create_skill_plugin`.
 *
 * Covers: file-write ordering and contents, env-var append (root vs
 * per-group), restartGroup invocation, rollback on partial failure,
 * rejected/expired notify path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
} from '../approval-primitive.js';
import {
  handleCreateSkillPluginRequest,
  registerCreateSkillPluginHandler,
  applyDecisionForTest,
  type CreateSkillPluginRequestTask,
} from '../create-skill-plugin.js';

let tmpProjectRoot: string;
let originalCwd: string;
let restartGroupSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
  restartGroupSpy = vi.fn().mockResolvedValue(undefined);
  registerCreateSkillPluginHandler({ restartGroup: restartGroupSpy });
  tmpProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-apply-'));
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

async function setupAndQueue(
  taskOverrides: Partial<CreateSkillPluginRequestTask> = {},
): Promise<{ approvalId: string; folder: string }> {
  ensureUser({ id: 'telegram:owner', kind: 'telegram' });
  grantRole({ user_id: 'telegram:owner', role: 'owner' });
  await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
  const ag = createAgentGroup({ name: 'main', folder: 'main' });
  const task: CreateSkillPluginRequestTask = {
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
    groupFolder: ag.folder,
    ...taskOverrides,
  };
  const approvalId = await handleCreateSkillPluginRequest(task, 'telegram');
  if (!approvalId) throw new Error('expected handler to return approvalId');
  return { approvalId, folder: ag.folder };
}

describe('applyDecision approved (skill-only, no creds)', () => {
  it('writes plugins/{name}/plugin.json and container-skills/SKILL.md', async () => {
    const { approvalId } = await setupAndQueue();
    await applyDecisionForTest(approvalId, 'approved');

    const pluginJsonPath = path.join(tmpProjectRoot, 'plugins', 'weather', 'plugin.json');
    expect(fs.existsSync(pluginJsonPath)).toBe(true);
    const json = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
    expect(json.name).toBe('weather');
    expect(json.version).toBe('1.0.0');

    const skillMdPath = path.join(
      tmpProjectRoot,
      'plugins',
      'weather',
      'container-skills',
      'SKILL.md',
    );
    expect(fs.existsSync(skillMdPath)).toBe(true);
    expect(fs.readFileSync(skillMdPath, 'utf8')).toContain('Weather');
  });

  it('writes private plugins under plugins/private/{name}', async () => {
    const { approvalId } = await setupAndQueue({
      pluginJson: {
        name: 'weather',
        description: 'Look up weather forecasts',
        version: '1.0.0',
        private: true,
        channels: ['*'],
        groups: ['main'],
      },
    });
    await applyDecisionForTest(approvalId, 'approved');

    const privatePluginJsonPath = path.join(
      tmpProjectRoot,
      'plugins',
      'private',
      'weather',
      'plugin.json',
    );
    expect(fs.existsSync(privatePluginJsonPath)).toBe(true);
    expect(fs.existsSync(path.join(tmpProjectRoot, 'plugins', 'weather'))).toBe(false);
    const json = JSON.parse(fs.readFileSync(privatePluginJsonPath, 'utf8'));
    expect(json.private).toBe(true);
  });

  it('writes .claude/skills/add-skill-{name}/SKILL.md and files/ tree', async () => {
    const { approvalId } = await setupAndQueue();
    await applyDecisionForTest(approvalId, 'approved');

    const skillRootMd = path.join(tmpProjectRoot, '.claude', 'skills', 'add-skill-weather', 'SKILL.md');
    const filesPluginJson = path.join(
      tmpProjectRoot,
      '.claude',
      'skills',
      'add-skill-weather',
      'files',
      'plugin.json',
    );
    expect(fs.existsSync(skillRootMd)).toBe(true);
    expect(fs.existsSync(filesPluginJson)).toBe(true);
  });

  it('does not append .env when no env vars', async () => {
    const { approvalId } = await setupAndQueue();
    await applyDecisionForTest(approvalId, 'approved');
    const rootEnv = path.join(tmpProjectRoot, '.env');
    expect(fs.existsSync(rootEnv)).toBe(false);
  });

  it('calls restartGroup once with originating folder', async () => {
    const { approvalId, folder } = await setupAndQueue();
    await applyDecisionForTest(approvalId, 'approved');
    expect(restartGroupSpy).toHaveBeenCalledTimes(1);
    expect(restartGroupSpy).toHaveBeenCalledWith(folder, expect.stringContaining('create_skill_plugin'));
  });
});

describe('applyDecision approved (mcp archetype with envVars)', () => {
  it('writes mcp.json and appends env vars to root .env (groups=[*])', async () => {
    const { approvalId } = await setupAndQueue({
      archetype: 'mcp',
      pluginJson: {
        name: 'github',
        description: 'GitHub MCP',
        version: '1.0.0',
        containerEnvVars: ['GH_TOKEN'],
        channels: ['*'],
        groups: ['*'],
      },
      mcpJson: '{"mcpServers":{"github":{"command":"npx","args":["-y","@some/gh"]}}}',
      envVarValues: { GH_TOKEN: 'ghp_secret' },
      name: 'github',
      description: 'GitHub MCP',
    });
    await applyDecisionForTest(approvalId, 'approved');

    const mcpPath = path.join(tmpProjectRoot, 'plugins', 'github', 'mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);

    const rootEnv = fs.readFileSync(path.join(tmpProjectRoot, '.env'), 'utf8');
    expect(rootEnv).toContain('GH_TOKEN=ghp_secret');
  });

  it('appends env vars to per-group .env when groups=[folder]', async () => {
    const { approvalId } = await setupAndQueue({
      archetype: 'mcp',
      pluginJson: {
        name: 'gh',
        description: 'GitHub MCP',
        version: '1.0.0',
        containerEnvVars: ['GH_TOKEN'],
        channels: ['*'],
        groups: ['main'],
      },
      mcpJson: '{"mcpServers":{"gh":{"command":"npx","args":["-y","@some/gh"]}}}',
      envVarValues: { GH_TOKEN: 'ghp_secret' },
      name: 'gh',
      description: 'GitHub MCP',
    });
    await applyDecisionForTest(approvalId, 'approved');

    const groupEnvPath = path.join(tmpProjectRoot, 'groups', 'main', '.env');
    const rootEnvPath = path.join(tmpProjectRoot, '.env');
    expect(fs.existsSync(groupEnvPath)).toBe(true);
    expect(fs.readFileSync(groupEnvPath, 'utf8')).toContain('GH_TOKEN=ghp_secret');
    expect(fs.existsSync(rootEnvPath)).toBe(false);
  });
});

describe('applyDecision rejected/expired', () => {
  it('writes no files and does not call restartGroup on rejected', async () => {
    const { approvalId } = await setupAndQueue();
    await applyDecisionForTest(approvalId, 'rejected');
    expect(fs.existsSync(path.join(tmpProjectRoot, 'plugins', 'weather'))).toBe(false);
    expect(fs.existsSync(path.join(tmpProjectRoot, '.claude', 'skills', 'add-skill-weather'))).toBe(false);
    expect(restartGroupSpy).not.toHaveBeenCalled();
  });

  it('writes no files and does not call restartGroup on expired', async () => {
    const { approvalId } = await setupAndQueue();
    await applyDecisionForTest(approvalId, 'expired');
    expect(fs.existsSync(path.join(tmpProjectRoot, 'plugins', 'weather'))).toBe(false);
    expect(restartGroupSpy).not.toHaveBeenCalled();
  });
});

describe('applyDecision rollback', () => {
  it('rolls back plugins/{name}/ when .claude/skills/ write fails', async () => {
    const { approvalId } = await setupAndQueue();
    // Setup is complete and approval queued. Now pre-create the .claude/skills/add-skill-weather
    // path as a FILE to force the second write step to fail (mkdir on a file path errors).
    fs.writeFileSync(
      path.join(tmpProjectRoot, '.claude', 'skills', 'add-skill-weather'),
      'blocker',
    );
    await applyDecisionForTest(approvalId, 'approved');
    // plugins/weather/ should be removed by rollback.
    expect(fs.existsSync(path.join(tmpProjectRoot, 'plugins', 'weather'))).toBe(false);
    expect(restartGroupSpy).not.toHaveBeenCalled();
  });
});
