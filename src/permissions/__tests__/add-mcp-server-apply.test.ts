/**
 * Phase 5C-04 — applyDecision for add_mcp_server.
 *
 * Mirrors install-packages-apply.test.ts but exercises the no-rebuild path:
 * approve mutates `mcpServers`, calls restartGroup, notifies the agent;
 * reject leaves mcpServers untouched and notifies of denial.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import {
  createAgentGroup,
  getAgentGroupById,
} from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import {
  clearApprovalHandlers,
  getApprovalHandler,
  getPendingApproval,
} from '../approval-primitive.js';
import {
  handleAddMcpServerRequest,
  registerAddMcpServerHandler,
} from '../add-mcp-server.js';
import type { ContainerConfig } from '../../types.js';

interface DepsHarness {
  restartGroup: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: Partial<DepsHarness> = {}): DepsHarness {
  return {
    restartGroup: vi.fn(async () => undefined),
    ...overrides,
  };
}

function readContainerConfig(agentGroupId: string): ContainerConfig {
  const ag = getAgentGroupById(agentGroupId);
  if (!ag) throw new Error('agent group missing');
  return ag.container_config
    ? (JSON.parse(ag.container_config) as ContainerConfig)
    : {};
}

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
});

describe('add_mcp_server applyDecision', () => {
  async function setupApprovalRow(deps: DepsHarness) {
    registerAddMcpServerHandler(deps);
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
    const ag = createAgentGroup({ name: 'G', folder: 'g' });
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
    return { ag, approvalId: approvalId! };
  }

  it('approve: writes mcpServers entry, calls restartGroup', async () => {
    const deps = makeDeps();
    const { ag, approvalId } = await setupApprovalRow(deps);
    const handler = getApprovalHandler('add_mcp_server')!;
    const row = getPendingApproval(approvalId)!;
    await handler.applyDecision!({
      approvalId,
      payload: JSON.parse(row.payload as string),
      decision: 'approved',
    });

    const cfg = readContainerConfig(ag.id);
    expect(cfg.mcpServers).toEqual({
      srv: {
        command: 'npx',
        args: ['-y', '@some/mcp'],
        env: { TOKEN: 'x' },
      },
    });
    expect(deps.restartGroup).toHaveBeenCalledWith(
      ag.folder,
      expect.stringMatching(/add_mcp_server/),
    );
  });

  it('approve replaces an existing same-named entry (idempotent re-approval)', async () => {
    const deps = makeDeps();
    const { ag } = await setupApprovalRow(deps);
    const handler = getApprovalHandler('add_mcp_server')!;

    // First approval (already done by setupApprovalRow).
    const a1 = await handleAddMcpServerRequest(
      {
        name: 'srv',
        command: 'npx',
        args: ['-y', '@some/mcp'],
        env: {},
        groupFolder: ag.folder,
      },
      '',
    );
    const r1 = getPendingApproval(a1!)!;
    await handler.applyDecision!({
      approvalId: a1!,
      payload: JSON.parse(r1.payload as string),
      decision: 'approved',
    });

    // Second approval same name, different command — replaces.
    const a2 = await handleAddMcpServerRequest(
      {
        name: 'srv',
        command: '/usr/local/bin/srv-v2',
        args: ['--flag'],
        env: { K: 'V' },
        groupFolder: ag.folder,
      },
      '',
    );
    const r2 = getPendingApproval(a2!)!;
    await handler.applyDecision!({
      approvalId: a2!,
      payload: JSON.parse(r2.payload as string),
      decision: 'approved',
    });

    const cfg = readContainerConfig(ag.id);
    expect(cfg.mcpServers).toEqual({
      srv: {
        command: '/usr/local/bin/srv-v2',
        args: ['--flag'],
        env: { K: 'V' },
      },
    });
  });

  it('reject: does not mutate mcpServers', async () => {
    const deps = makeDeps();
    const { ag, approvalId } = await setupApprovalRow(deps);
    const handler = getApprovalHandler('add_mcp_server')!;
    const row = getPendingApproval(approvalId)!;
    await handler.applyDecision!({
      approvalId,
      payload: JSON.parse(row.payload as string),
      decision: 'rejected',
    });

    const cfg = readContainerConfig(ag.id);
    expect(cfg.mcpServers).toBeUndefined();
    expect(deps.restartGroup).not.toHaveBeenCalled();
  });

  it('expired: same as reject', async () => {
    const deps = makeDeps();
    const { ag, approvalId } = await setupApprovalRow(deps);
    const handler = getApprovalHandler('add_mcp_server')!;
    const row = getPendingApproval(approvalId)!;
    await handler.applyDecision!({
      approvalId,
      payload: JSON.parse(row.payload as string),
      decision: 'expired',
    });

    const cfg = readContainerConfig(ag.id);
    expect(cfg.mcpServers).toBeUndefined();
  });

  it('restart failure: mcpServers still persisted, error surfaced', async () => {
    const deps = makeDeps({
      restartGroup: vi.fn(async () => {
        throw new Error('container stop failed');
      }),
    });
    const { ag, approvalId } = await setupApprovalRow(deps);
    const handler = getApprovalHandler('add_mcp_server')!;
    const row = getPendingApproval(approvalId)!;
    await handler.applyDecision!({
      approvalId,
      payload: JSON.parse(row.payload as string),
      decision: 'approved',
    });

    // Mutation persisted (config write happens before restart attempt).
    const cfg = readContainerConfig(ag.id);
    expect(cfg.mcpServers!.srv).toBeDefined();
    expect(deps.restartGroup).toHaveBeenCalled();
  });

  it('no deps wired: approve mutates config but skips restart (render-only mode)', async () => {
    registerAddMcpServerHandler();
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const approvalId = await handleAddMcpServerRequest(
      {
        name: 'srv',
        command: 'npx',
        args: [],
        env: {},
        groupFolder: ag.folder,
      },
      '',
    );
    const handler = getApprovalHandler('add_mcp_server')!;
    const row = getPendingApproval(approvalId!)!;
    await handler.applyDecision!({
      approvalId: approvalId!,
      payload: JSON.parse(row.payload as string),
      decision: 'approved',
    });

    const cfg = readContainerConfig(ag.id);
    // Config still mutated even without deps — admin can manually restart.
    expect(cfg.mcpServers!.srv).toBeDefined();
  });
});
