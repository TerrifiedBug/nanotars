/**
 * Phase 5C-06 — end-to-end install_packages / add_mcp_server flow.
 *
 * Drives `processTaskIpc` directly with a self-mod payload and asserts the
 * full chain produces:
 *   1. A pending_approvals row with the right action + payload + agent_group_id.
 *   2. On admin approve → container_config mutated, buildImage + restartGroup
 *      called (mocked), notifyAfter scheduled, agent notified via the
 *      synthetic-inbound system message.
 *   3. On admin reject → no mutation, denial system message injected.
 *   4. On invalid input → no approval row, error system message injected.
 *
 * Mocks:
 *   - container-runner build is replaced via dependency injection in
 *     registerInstallPackagesHandler so no actual docker process runs.
 *   - container-runtime is unused on this path (queue is a fresh GroupQueue
 *     with no active containers, so restartGroup short-circuits).
 *
 * Safety-critical scope: this is the test the spec called out as the first
 * line of defense against silent breakage of the self-mod approval path
 * — it covers the full handshake from container IPC to agent notification.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, getDb } from '../db/init.js';
import {
  createAgentGroup,
  createMessagingGroup,
  createWiring,
  getAgentGroupById,
} from '../db/agent-groups.js';
import { processTaskIpc } from '../ipc/tasks.js';
import { ensureUser } from '../permissions/users.js';
import { grantRole } from '../permissions/user-roles.js';
import { ensureUserDm } from '../permissions/user-dms.js';
import {
  clearApprovalHandlers,
  getApprovalHandler,
  getPendingApproval,
  listPendingApprovalsByAction,
} from '../permissions/approval-primitive.js';
import { registerInstallPackagesHandler } from '../permissions/install-packages.js';
import { registerAddMcpServerHandler } from '../permissions/add-mcp-server.js';
import type { IpcDeps } from '../ipc/types.js';
import type { ContainerConfig } from '../types.js';

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

function readContainerConfig(agentGroupId: string): ContainerConfig {
  const ag = getAgentGroupById(agentGroupId);
  if (!ag) throw new Error('agent group missing');
  return ag.container_config
    ? (JSON.parse(ag.container_config) as ContainerConfig)
    : {};
}

interface Harness {
  buildImage: ReturnType<typeof vi.fn>;
  restartGroup: ReturnType<typeof vi.fn>;
  notifyAfter: ReturnType<typeof vi.fn>;
  agId: string;
  folder: string;
  chatJid: string;
}

async function setupAgentGroupAndApprover(): Promise<Harness> {
  // Wire the agent group to a chat so notifyAgent can deliver back.
  const ag = createAgentGroup({ name: 'G', folder: 'g' });
  const mg = createMessagingGroup({
    channel_type: 'telegram',
    platform_id: 'tg:agent-chat',
    name: 'agent-chat',
  });
  createWiring({
    messaging_group_id: mg.id,
    agent_group_id: ag.id,
    engage_pattern: '.*',
  });

  // Owner so requestApproval picks an approver.
  ensureUser({ id: 'telegram:owner', kind: 'telegram' });
  grantRole({ user_id: 'telegram:owner', role: 'owner' });
  await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

  const buildImage = vi.fn(async () => 'nanoclaw-agent:test');
  const restartGroup = vi.fn(async () => undefined);
  const notifyAfter = vi.fn();

  registerInstallPackagesHandler({ buildImage, restartGroup, notifyAfter });
  registerAddMcpServerHandler({ restartGroup });

  return {
    buildImage,
    restartGroup,
    notifyAfter,
    agId: ag.id,
    folder: ag.folder,
    chatJid: 'tg:agent-chat',
  };
}

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
  vi.clearAllMocks();
});

// ── install_packages ────────────────────────────────────────────────────────

describe('processTaskIpc: install_packages end-to-end', () => {
  it('happy path: IPC → approval → approve → mutate + build + restart + notify', async () => {
    const h = await setupAgentGroupAndApprover();

    // Step 1: agent emits install_packages IPC.
    await processTaskIpc(
      {
        type: 'install_packages',
        apt: ['curl'],
        npm: ['typescript'],
        reason: 'tools needed',
      },
      h.folder,
      true,
      makeDeps(),
    );

    // Step 2: a pending_approvals row exists.
    const rows = listPendingApprovalsByAction('install_packages');
    expect(rows).toHaveLength(1);
    const approvalId = rows[0].approval_id as string;
    const approval = getPendingApproval(approvalId)!;
    expect(approval.agent_group_id).toBe(h.agId);

    const payload = JSON.parse(approval.payload as string);
    expect(payload.apt).toEqual(['curl']);
    expect(payload.npm).toEqual(['typescript']);

    // Step 3: admin approves → applyDecision dispatched.
    const handler = getApprovalHandler('install_packages')!;
    await handler.applyDecision!({
      approvalId,
      payload,
      decision: 'approved',
    });

    // Step 4: container_config mutated.
    const cfg = readContainerConfig(h.agId);
    expect(cfg.packages).toEqual({ apt: ['curl'], npm: ['typescript'] });

    // Step 5: buildImage + restartGroup called.
    expect(h.buildImage).toHaveBeenCalledWith(h.agId);
    expect(h.restartGroup).toHaveBeenCalledWith(
      h.folder,
      expect.stringMatching(/install_packages/),
    );

    // Step 6: notifyAfter scheduled the post-rebuild verify prompt.
    expect(h.notifyAfter).toHaveBeenCalledTimes(1);
    const [groupId, text, deferMs] = h.notifyAfter.mock.calls[0];
    expect(groupId).toBe(h.agId);
    expect(text).toMatch(/Packages installed/);
    expect(deferMs).toBe(5000);
  });

  it('rejected: no mutation; agent receives a denial system message', async () => {
    const h = await setupAgentGroupAndApprover();
    await processTaskIpc(
      {
        type: 'install_packages',
        apt: ['curl'],
        npm: [],
        reason: 'r',
      },
      h.folder,
      true,
      makeDeps(),
    );
    const rows = listPendingApprovalsByAction('install_packages');
    const approvalId = rows[0].approval_id as string;
    const handler = getApprovalHandler('install_packages')!;
    await handler.applyDecision!({
      approvalId,
      payload: JSON.parse(rows[0].payload as string),
      decision: 'rejected',
    });

    // Config unchanged.
    const cfg = readContainerConfig(h.agId);
    expect(cfg.packages).toBeUndefined();
    expect(h.buildImage).not.toHaveBeenCalled();
    expect(h.restartGroup).not.toHaveBeenCalled();

    // Agent received the denial via system message (5C-05 injection path).
    const denial = getDb()
      .prepare(
        `SELECT content FROM messages WHERE chat_jid = ? AND content LIKE ?`,
      )
      .get(h.chatJid, '[system] install_packages rejected%') as
      | { content: string }
      | undefined;
    expect(denial).toBeDefined();
    expect(denial!.content).toMatch(/apt:curl/);
  });

  it('invalid apt name: no approval row; agent notified of validation failure', async () => {
    const h = await setupAgentGroupAndApprover();
    await processTaskIpc(
      {
        type: 'install_packages',
        apt: ['curl=1.0'],
        npm: [],
        reason: 'r',
      },
      h.folder,
      true,
      makeDeps(),
    );

    expect(listPendingApprovalsByAction('install_packages')).toHaveLength(0);

    const errMsg = getDb()
      .prepare(
        `SELECT content FROM messages WHERE chat_jid = ? AND content LIKE ?`,
      )
      .get(h.chatJid, '[system] install_packages failed: invalid apt%') as
      | { content: string }
      | undefined;
    expect(errMsg).toBeDefined();
    expect(errMsg!.content).toMatch(/curl=1\.0/);
  });

  it('agent notified via system message even when notifyAfter is a stub', async () => {
    // Verify the inbound row from notifyAgent — proves the pipeline is wired
    // even though notifyAfter itself is a deferred scheduler in production.
    const h = await setupAgentGroupAndApprover();
    await processTaskIpc(
      {
        type: 'install_packages',
        apt: ['curl'],
        npm: [],
        reason: 'r',
      },
      h.folder,
      true,
      makeDeps(),
    );
    const rows = listPendingApprovalsByAction('install_packages');
    const approvalId = rows[0].approval_id as string;
    const handler = getApprovalHandler('install_packages')!;

    // Wire notifyAfter to fire immediately so we can assert the message lands.
    h.notifyAfter.mockImplementation((groupId: string, text: string) => {
      // Inline import to avoid hoisting issues.
      void import('../permissions/approval-primitive.js').then((m) =>
        m.notifyAgent(groupId, text),
      );
    });

    await handler.applyDecision!({
      approvalId,
      payload: JSON.parse(rows[0].payload as string),
      decision: 'approved',
    });

    // notifyAfter was called; the immediate-fire stub delegates to notifyAgent.
    // Wait a microtask for the dynamic import to resolve.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const sysMsg = getDb()
      .prepare(
        `SELECT content FROM messages WHERE chat_jid = ? AND content LIKE ?`,
      )
      .get(h.chatJid, '[system] Packages installed%') as
      | { content: string }
      | undefined;
    expect(sysMsg).toBeDefined();
  });
});

// ── add_mcp_server ─────────────────────────────────────────────────────────

describe('processTaskIpc: add_mcp_server end-to-end', () => {
  it('happy path: IPC → approval → approve → mutate + restart + notify', async () => {
    const h = await setupAgentGroupAndApprover();

    await processTaskIpc(
      {
        type: 'add_mcp_server',
        name: 'srv',
        command: 'npx',
        args: ['-y', '@some/mcp'],
        env: { TOKEN: 'x' },
      },
      h.folder,
      true,
      makeDeps(),
    );

    const rows = listPendingApprovalsByAction('add_mcp_server');
    expect(rows).toHaveLength(1);
    const approvalId = rows[0].approval_id as string;

    const handler = getApprovalHandler('add_mcp_server')!;
    await handler.applyDecision!({
      approvalId,
      payload: JSON.parse(rows[0].payload as string),
      decision: 'approved',
    });

    const cfg = readContainerConfig(h.agId);
    expect(cfg.mcpServers).toEqual({
      srv: { command: 'npx', args: ['-y', '@some/mcp'], env: { TOKEN: 'x' } },
    });
    expect(h.restartGroup).toHaveBeenCalledWith(
      h.folder,
      expect.stringMatching(/add_mcp_server/),
    );

    // Agent notified via system message.
    const sysMsg = getDb()
      .prepare(
        `SELECT content FROM messages WHERE chat_jid = ? AND content LIKE ?`,
      )
      .get(h.chatJid, '[system] MCP server%') as
      | { content: string }
      | undefined;
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.content).toMatch(/Container restarting/);
  });

  it('command not on allowlist: drops + notifies, no approval row', async () => {
    const h = await setupAgentGroupAndApprover();
    await processTaskIpc(
      {
        type: 'add_mcp_server',
        name: 'srv',
        command: '/etc/passwd',
        args: [],
        env: {},
      },
      h.folder,
      true,
      makeDeps(),
    );
    expect(listPendingApprovalsByAction('add_mcp_server')).toHaveLength(0);

    const errMsg = getDb()
      .prepare(
        `SELECT content FROM messages WHERE chat_jid = ? AND content LIKE ?`,
      )
      .get(h.chatJid, '[system] add_mcp_server failed: command%') as
      | { content: string }
      | undefined;
    expect(errMsg).toBeDefined();
    expect(errMsg!.content).toMatch(/etc\/passwd/);
  });

  it('rejected: no mutation; denial system message', async () => {
    const h = await setupAgentGroupAndApprover();
    await processTaskIpc(
      {
        type: 'add_mcp_server',
        name: 'srv',
        command: 'npx',
        args: [],
        env: {},
      },
      h.folder,
      true,
      makeDeps(),
    );
    const rows = listPendingApprovalsByAction('add_mcp_server');
    const handler = getApprovalHandler('add_mcp_server')!;
    await handler.applyDecision!({
      approvalId: rows[0].approval_id as string,
      payload: JSON.parse(rows[0].payload as string),
      decision: 'rejected',
    });

    const cfg = readContainerConfig(h.agId);
    expect(cfg.mcpServers).toBeUndefined();
    expect(h.restartGroup).not.toHaveBeenCalled();

    const denial = getDb()
      .prepare(
        `SELECT content FROM messages WHERE chat_jid = ? AND content LIKE ?`,
      )
      .get(h.chatJid, '[system] add_mcp_server rejected%') as
      | { content: string }
      | undefined;
    expect(denial).toBeDefined();
  });
});
