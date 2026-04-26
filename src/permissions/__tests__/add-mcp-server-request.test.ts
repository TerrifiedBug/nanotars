/**
 * Phase 5C-03 — host-side request flow for `add_mcp_server`.
 *
 * Covers the command-allowlist (locked at spec time: npx, node, python,
 * python3, bash + paths under /usr/local/bin/ or /workspace/) and the
 * requestApproval round-trip.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import {
  clearApprovalHandlers,
  getPendingApproval,
  listPendingApprovalsByAction,
} from '../approval-primitive.js';
import {
  ALLOWED_COMMAND_BASES,
  ALLOWED_PATH_PREFIXES,
  handleAddMcpServerRequest,
  isCommandAllowed,
  registerAddMcpServerHandler,
} from '../add-mcp-server.js';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
  registerAddMcpServerHandler();
});

describe('isCommandAllowed', () => {
  it('accepts each whitelisted bare basename', () => {
    for (const cmd of ALLOWED_COMMAND_BASES) {
      expect(isCommandAllowed(cmd), cmd).toBe(true);
    }
  });

  it('accepts paths under /usr/local/bin/ and /workspace/', () => {
    expect(isCommandAllowed('/usr/local/bin/my-mcp')).toBe(true);
    expect(isCommandAllowed('/workspace/build/server')).toBe(true);
  });

  it('rejects bare commands not on the allowlist', () => {
    for (const bad of ['curl', 'wget', '/bin/sh', 'nc', 'ssh']) {
      expect(isCommandAllowed(bad), bad).toBe(false);
    }
  });

  it('rejects paths outside the allowed prefixes', () => {
    expect(isCommandAllowed('/etc/passwd')).toBe(false);
    expect(isCommandAllowed('/tmp/x')).toBe(false);
    expect(isCommandAllowed('/home/me/binary')).toBe(false);
    expect(isCommandAllowed('../etc/passwd')).toBe(false);
  });

  it('exports stable allowlist constants', () => {
    // Locked at spec time per task brief — guard against drift.
    expect([...ALLOWED_COMMAND_BASES].sort()).toEqual([
      'bash',
      'node',
      'npx',
      'python',
      'python3',
    ]);
    expect(ALLOWED_PATH_PREFIXES).toEqual(['/usr/local/bin/', '/workspace/']);
  });
});

describe('handleAddMcpServerRequest', () => {
  async function setupGroupWithApprover() {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
    return createAgentGroup({ name: 'G', folder: 'g' });
  }

  it('happy path: creates pending_approvals row with name + command + args + env', async () => {
    const ag = await setupGroupWithApprover();
    const approvalId = await handleAddMcpServerRequest(
      {
        name: 'srv',
        command: 'npx',
        args: ['-y', '@some/mcp'],
        env: { TOKEN: 'x' },
        groupFolder: ag.folder,
      },
      'telegram',
    );
    expect(approvalId).toBeTruthy();
    const row = getPendingApproval(approvalId!);
    expect(row!.action).toBe('add_mcp_server');
    expect(row!.title).toBe('Add MCP Server Request');

    const payload = JSON.parse(row!.payload as string);
    expect(payload.name).toBe('srv');
    expect(payload.command).toBe('npx');
    expect(payload.args).toEqual(['-y', '@some/mcp']);
    expect(payload.env).toEqual({ TOKEN: 'x' });
  });

  it('drops when agent group not found', async () => {
    const approvalId = await handleAddMcpServerRequest(
      {
        name: 'srv',
        command: 'npx',
        args: [],
        env: {},
        groupFolder: 'no-such-group',
      },
      '',
    );
    expect(approvalId).toBeUndefined();
    expect(listPendingApprovalsByAction('add_mcp_server')).toHaveLength(0);
  });

  it('rejects missing name or command', async () => {
    const ag = await setupGroupWithApprover();

    expect(
      await handleAddMcpServerRequest(
        { name: '', command: 'npx', args: [], env: {}, groupFolder: ag.folder },
        '',
      ),
    ).toBeUndefined();
    expect(
      await handleAddMcpServerRequest(
        { name: 'srv', command: '', args: [], env: {}, groupFolder: ag.folder },
        '',
      ),
    ).toBeUndefined();
    expect(listPendingApprovalsByAction('add_mcp_server')).toHaveLength(0);
  });

  it('rejects commands not on the allowlist', async () => {
    const ag = await setupGroupWithApprover();
    for (const bad of ['curl', '/bin/sh', '/etc/passwd', 'nc', '../escape']) {
      const approvalId = await handleAddMcpServerRequest(
        {
          name: 'srv',
          command: bad,
          args: [],
          env: {},
          groupFolder: ag.folder,
        },
        '',
      );
      expect(approvalId, `should reject "${bad}"`).toBeUndefined();
    }
    expect(listPendingApprovalsByAction('add_mcp_server')).toHaveLength(0);
  });

  it('accepts /workspace/ and /usr/local/bin/ paths', async () => {
    const ag = await setupGroupWithApprover();
    const a1 = await handleAddMcpServerRequest(
      {
        name: 's1',
        command: '/usr/local/bin/my-mcp',
        args: [],
        env: {},
        groupFolder: ag.folder,
      },
      '',
    );
    const a2 = await handleAddMcpServerRequest(
      {
        name: 's2',
        command: '/workspace/build/server',
        args: [],
        env: {},
        groupFolder: ag.folder,
      },
      '',
    );
    expect(a1).toBeTruthy();
    expect(a2).toBeTruthy();
    expect(listPendingApprovalsByAction('add_mcp_server')).toHaveLength(2);
  });
});
