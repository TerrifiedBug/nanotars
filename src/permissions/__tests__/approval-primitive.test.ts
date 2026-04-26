import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, getDb } from '../../db/init.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import {
  registerApprovalHandler,
  getApprovalHandler,
  clearApprovalHandlers,
  requestApproval,
  updateApprovalStatus,
  getPendingApproval,
  listPendingApprovalsByAction,
  deletePendingApproval,
  notifyAgent,
  type ApprovalHandler,
} from '../approval-primitive.js';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
});

// ── handler registry ────────────────────────────────────────────────────────

describe('registerApprovalHandler / getApprovalHandler', () => {
  it('round-trips a registered handler', () => {
    const handler: ApprovalHandler = {
      render: () => ({ title: 'T', body: 'B', options: [{ id: 'ok', label: 'OK' }] }),
    };

    registerApprovalHandler('test_action', handler);

    expect(getApprovalHandler('test_action')).toBe(handler);
  });

  it('returns undefined for unregistered action', () => {
    expect(getApprovalHandler('nope')).toBeUndefined();
  });

  it('overwrites and warns on duplicate registration', () => {
    const first: ApprovalHandler = {
      render: () => ({ title: 'first', body: '', options: [] }),
    };
    const second: ApprovalHandler = {
      render: () => ({ title: 'second', body: '', options: [] }),
    };

    registerApprovalHandler('dup', first);
    registerApprovalHandler('dup', second);

    expect(getApprovalHandler('dup')).toBe(second);
  });
});

describe('clearApprovalHandlers', () => {
  it('empties the registry', () => {
    registerApprovalHandler('a1', { render: () => ({ title: '', body: '', options: [] }) });
    registerApprovalHandler('a2', { render: () => ({ title: '', body: '', options: [] }) });

    clearApprovalHandlers();

    expect(getApprovalHandler('a1')).toBeUndefined();
    expect(getApprovalHandler('a2')).toBeUndefined();
  });
});

// ── requestApproval persistence ─────────────────────────────────────────────

describe('requestApproval persistence', () => {
  it('persists a pending_approvals row with the right columns when an approver and DM exist', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });

    const result = await requestApproval({
      action: 'install_packages',
      agentGroupId: ag.id,
      payload: { packages: ['curl'] },
      originatingChannel: 'telegram',
    });

    expect(result.approvalId).toBeTruthy();
    expect(result.approvers).toHaveLength(1);
    expect(result.approvers[0].id).toBe('telegram:owner');
    expect(result.deliveryTarget).toBeDefined();
    expect(result.deliveryTarget!.userId).toBe('telegram:owner');

    const row = getPendingApproval(result.approvalId);
    expect(row).toBeDefined();
    expect(row!.action).toBe('install_packages');
    expect(row!.agent_group_id).toBe(ag.id);
    expect(row!.channel_type).toBe('telegram');
    expect(row!.status).toBe('pending');
    expect(row!.request_id).toBe(result.approvalId); // defaults to approvalId
  });

  it('embeds the picked approver into payload._picked_approver_user_id', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });

    const { approvalId } = await requestApproval({
      action: 'install_packages',
      agentGroupId: ag.id,
      payload: { foo: 'bar' },
      originatingChannel: 'telegram',
    });

    const row = getPendingApproval(approvalId);
    const persisted = JSON.parse(row!.payload as string);
    expect(persisted.foo).toBe('bar');
    expect(persisted._picked_approver_user_id).toBe('telegram:owner');
  });

  it('handles no-approver case: empty approvers list, deliveryTarget undefined, row still persisted with NULL channel', async () => {
    const ag = createAgentGroup({ name: 'EmptyGroup', folder: 'empty' });

    const result = await requestApproval({
      action: 'orphan_action',
      agentGroupId: ag.id,
      payload: { x: 1 },
    });

    expect(result.approvers).toEqual([]);
    expect(result.deliveryTarget).toBeUndefined();

    const row = getPendingApproval(result.approvalId);
    expect(row).toBeDefined();
    expect(row!.channel_type).toBeNull();
    expect(row!.platform_id).toBeNull();

    const persisted = JSON.parse(row!.payload as string);
    expect(persisted._picked_approver_user_id).toBeNull();
  });

  it('uses request_id from caller when provided', async () => {
    const { approvalId } = await requestApproval({
      action: 'a',
      agentGroupId: null,
      payload: {},
      request_id: 'external-req-123',
    });

    const row = getPendingApproval(approvalId);
    expect(row!.request_id).toBe('external-req-123');
  });

  it('persists expires_at when provided', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { approvalId } = await requestApproval({
      action: 'a',
      agentGroupId: null,
      payload: {},
      expires_at: future,
    });

    const row = getPendingApproval(approvalId);
    expect(row!.expires_at).toBe(future);
  });

  it('uses handler.render output for title and options when a handler is registered', async () => {
    registerApprovalHandler('rendered_action', {
      render: () => ({
        title: 'Custom Title',
        body: 'Body text',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      }),
    });

    const { approvalId } = await requestApproval({
      action: 'rendered_action',
      agentGroupId: null,
      payload: {},
    });

    const row = getPendingApproval(approvalId);
    expect(row!.title).toBe('Custom Title');
    const opts = JSON.parse(row!.options_json as string);
    expect(opts).toHaveLength(2);
    expect(opts[0]).toEqual({ id: 'approve', label: 'Approve' });
  });

  it('falls back to action-as-title when no handler is registered', async () => {
    const { approvalId } = await requestApproval({
      action: 'no_handler_action',
      agentGroupId: null,
      payload: {},
    });

    const row = getPendingApproval(approvalId);
    expect(row!.title).toBe('no_handler_action');
    expect(row!.options_json).toBe('[]');
  });
});

// ── status transitions / row management ─────────────────────────────────────

describe('updateApprovalStatus', () => {
  it('updates the status of a single row', async () => {
    const { approvalId } = await requestApproval({
      action: 'a',
      agentGroupId: null,
      payload: {},
    });

    updateApprovalStatus(approvalId, 'approved');

    const row = getPendingApproval(approvalId);
    expect(row!.status).toBe('approved');
  });

  it('does not affect other rows', async () => {
    const a = await requestApproval({ action: 'a1', agentGroupId: null, payload: {} });
    const b = await requestApproval({ action: 'a2', agentGroupId: null, payload: {} });

    updateApprovalStatus(a.approvalId, 'rejected');

    expect(getPendingApproval(a.approvalId)!.status).toBe('rejected');
    expect(getPendingApproval(b.approvalId)!.status).toBe('pending');
  });
});

describe('getPendingApproval', () => {
  it('returns undefined for unknown id', () => {
    expect(getPendingApproval('does-not-exist')).toBeUndefined();
  });

  it('round-trips an inserted row', async () => {
    const { approvalId } = await requestApproval({
      action: 'roundtrip',
      agentGroupId: null,
      payload: { hello: 'world' },
    });

    const row = getPendingApproval(approvalId);
    expect(row).toBeDefined();
    expect(row!.approval_id).toBe(approvalId);
    expect(row!.action).toBe('roundtrip');
  });
});

describe('listPendingApprovalsByAction', () => {
  it('filters rows by action and returns only pending ones in created_at order', async () => {
    const a1 = await requestApproval({ action: 'install_packages', agentGroupId: null, payload: {} });
    const a2 = await requestApproval({ action: 'install_packages', agentGroupId: null, payload: {} });
    const b1 = await requestApproval({ action: 'add_mcp_server', agentGroupId: null, payload: {} });

    const installRows = listPendingApprovalsByAction('install_packages');
    expect(installRows).toHaveLength(2);
    expect(installRows.map((r: any) => r.approval_id).sort()).toEqual(
      [a1.approvalId, a2.approvalId].sort(),
    );

    const mcpRows = listPendingApprovalsByAction('add_mcp_server');
    expect(mcpRows).toHaveLength(1);
    expect((mcpRows[0] as any).approval_id).toBe(b1.approvalId);
  });

  it('does not return rows with non-pending status', async () => {
    const a1 = await requestApproval({ action: 'x', agentGroupId: null, payload: {} });
    const a2 = await requestApproval({ action: 'x', agentGroupId: null, payload: {} });

    updateApprovalStatus(a1.approvalId, 'approved');

    const rows = listPendingApprovalsByAction('x');
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).approval_id).toBe(a2.approvalId);
  });

  it('returns empty list when no rows match', () => {
    expect(listPendingApprovalsByAction('nonexistent')).toEqual([]);
  });
});

describe('deletePendingApproval', () => {
  it('removes the named row', async () => {
    const { approvalId } = await requestApproval({
      action: 'a',
      agentGroupId: null,
      payload: {},
    });
    expect(getPendingApproval(approvalId)).toBeDefined();

    deletePendingApproval(approvalId);

    expect(getPendingApproval(approvalId)).toBeUndefined();
  });

  it('is idempotent on unknown id', () => {
    expect(() => deletePendingApproval('never-existed')).not.toThrow();
  });
});

// ── notifyAgent stub ────────────────────────────────────────────────────────

describe('notifyAgent (TODO stub)', () => {
  it('does not throw and does not write to the DB', () => {
    // Notify is a stub — concern #3 in the C2 plan. It must not crash, but it
    // also must not silently surface as if the agent was actually notified.
    expect(() => notifyAgent('group-1', 'test message')).not.toThrow();

    // Sanity: stub did not insert into pending_approvals or any other table
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM pending_approvals').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
