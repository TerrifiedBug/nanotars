/**
 * Slice 6 — end-to-end: IPC task → handler → approval → applyDecision
 * → files written → restart invoked.
 *
 * Drives the host-side flow with a fake IPC task that mirrors what the
 * agent-runner's create_skill_plugin MCP tool would emit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { _initTestDatabase, getDb } from '../../db/init.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../../permissions/users.js';
import { grantRole } from '../../permissions/user-roles.js';
import { ensureUserDm } from '../../permissions/user-dms.js';
import {
  clearApprovalHandlers,
} from '../../permissions/approval-primitive.js';
import {
  registerApprovalEditor,
  clearApprovalEditors,
  editApprovalCardOnDecision,
} from '../../permissions/approval-delivery.js';
import {
  registerCreateSkillPluginHandler,
  applyDecisionForTest,
  handleCreateSkillPluginRequest,
} from '../../permissions/create-skill-plugin.js';

let tmpProjectRoot: string;
let originalCwd: string;
let restartGroupSpy: ReturnType<typeof vi.fn>;
let editorSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  _initTestDatabase();
  clearApprovalHandlers();
  clearApprovalEditors();
  restartGroupSpy = vi.fn().mockResolvedValue(undefined);
  editorSpy = vi.fn(async () => ({ ok: true as const }));
  registerApprovalEditor('telegram', editorSpy);
  registerCreateSkillPluginHandler({ restartGroup: restartGroupSpy });
  tmpProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-e2e-'));
  fs.mkdirSync(path.join(tmpProjectRoot, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(tmpProjectRoot, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(tmpProjectRoot, 'groups', 'main'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(tmpProjectRoot);

  ensureUser({ id: 'telegram:owner', kind: 'telegram' });
  grantRole({ user_id: 'telegram:owner', role: 'owner' });
  await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
  createAgentGroup({ name: 'main', folder: 'main' });
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpProjectRoot, { recursive: true, force: true });
});

describe('e2e: create_skill_plugin (skill-only, no creds)', () => {
  it('IPC task → approval queued → approve → files written → restart called', async () => {
    const approvalId = await handleCreateSkillPluginRequest(
      {
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
        containerSkillMd: '# Weather\n\nFetch from wttr.in',
        groupFolder: 'main',
      },
      'telegram',
    );
    expect(approvalId).toBeTruthy();

    await applyDecisionForTest(approvalId!, 'approved');

    // Stamp platform_message_id + status on the row so editApprovalCardOnDecision
    // can find a target (applyDecisionForTest bypasses the click router which
    // normally does both).
    getDb()
      .prepare(
        `UPDATE pending_approvals
            SET platform_message_id = 'mid-1', status = 'approved'
          WHERE approval_id = ?`,
      )
      .run(approvalId!);
    await editApprovalCardOnDecision(approvalId!);

    expect(editorSpy).toHaveBeenCalled();
    const editCall = editorSpy.mock.calls[editorSpy.mock.calls.length - 1][0];
    expect(editCall.decision).toBe('approved');

    expect(fs.existsSync(path.join(tmpProjectRoot, 'plugins', 'weather', 'plugin.json'))).toBe(true);
    expect(
      fs.existsSync(path.join(tmpProjectRoot, '.claude', 'skills', 'add-skill-weather', 'SKILL.md')),
    ).toBe(true);
    expect(restartGroupSpy).toHaveBeenCalledWith('main', expect.stringContaining('create_skill_plugin'));
  });
});

describe('e2e: create_skill_plugin (mcp with credentials)', () => {
  it('writes mcp.json, appends GH_TOKEN to root .env, restart called', async () => {
    const approvalId = await handleCreateSkillPluginRequest(
      {
        name: 'github',
        description: 'GitHub via MCP',
        archetype: 'mcp',
        pluginJson: {
          name: 'github',
          description: 'GitHub via MCP',
          version: '1.0.0',
          containerEnvVars: ['GH_TOKEN'],
          channels: ['*'],
          groups: ['*'],
        },
        containerSkillMd: '# GitHub\n\nUse mcp__github tools',
        mcpJson: '{"mcpServers":{"github":{"command":"npx","args":["-y","@some/gh"]}}}',
        envVarValues: { GH_TOKEN: 'ghp_secret' },
        groupFolder: 'main',
      },
      'telegram',
    );
    expect(approvalId).toBeTruthy();

    await applyDecisionForTest(approvalId!, 'approved');

    expect(fs.existsSync(path.join(tmpProjectRoot, 'plugins', 'github', 'mcp.json'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpProjectRoot, '.env'), 'utf8')).toContain('GH_TOKEN=ghp_secret');
    expect(restartGroupSpy).toHaveBeenCalledOnce();
  });
});

describe('e2e: create_skill_plugin negative paths', () => {
  it('rejects archetype="host-hook" pre-approval — no files, no restart', async () => {
    const approvalId = await handleCreateSkillPluginRequest(
      // @ts-expect-error testing runtime guard
      {
        name: 'evil',
        description: 'evil',
        archetype: 'host-hook',
        pluginJson: { name: 'evil', description: 'evil', version: '1.0.0', channels: ['*'], groups: ['*'] },
        containerSkillMd: '# x',
        groupFolder: 'main',
      },
      'telegram',
    );
    expect(approvalId).toBeUndefined();
    expect(restartGroupSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpProjectRoot, 'plugins', 'evil'))).toBe(false);
  });

  it('rejected admin decision — no files written, no restart', async () => {
    const approvalId = await handleCreateSkillPluginRequest(
      {
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
        containerSkillMd: '# Weather',
        groupFolder: 'main',
      },
      'telegram',
    );
    await applyDecisionForTest(approvalId!, 'rejected');
    expect(fs.existsSync(path.join(tmpProjectRoot, 'plugins', 'weather'))).toBe(false);
    expect(restartGroupSpy).not.toHaveBeenCalled();
  });
});
