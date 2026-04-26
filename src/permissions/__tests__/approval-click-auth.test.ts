import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import {
  registerApprovalHandler,
  clearApprovalHandlers,
  requestApproval,
  getPendingApproval,
  updateApprovalStatus,
  type ApprovalHandler,
} from '../approval-primitive.js';
import { isAuthorizedClicker, handleApprovalClick } from '../approval-click-auth.js';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
});

// ── isAuthorizedClicker (pure auth) ─────────────────────────────────────────

describe('isAuthorizedClicker', () => {
  it('approver-self: clicker === approver_user_id → authorized', () => {
    ensureUser({ id: 'telegram:alice', kind: 'telegram' });

    const result = isAuthorizedClicker({
      clicker_user_id: 'telegram:alice',
      approver_user_id: 'telegram:alice',
      agent_group_id: 'group-1',
    });

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('approver-self');
  });

  it('owner-override: non-approver who is global owner → authorized', () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const result = isAuthorizedClicker({
      clicker_user_id: 'telegram:owner',
      approver_user_id: 'telegram:somebody-else',
      agent_group_id: 'group-1',
    });

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('owner-override');
  });

  it('global-admin-override: non-approver who is global admin → authorized', () => {
    ensureUser({ id: 'telegram:admin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:admin', role: 'admin' });

    const result = isAuthorizedClicker({
      clicker_user_id: 'telegram:admin',
      approver_user_id: 'telegram:somebody-else',
      agent_group_id: 'group-1',
    });

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('global-admin-override');
  });

  it('scoped-admin-override: scoped admin of THIS agent_group → authorized', () => {
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag.id });

    const result = isAuthorizedClicker({
      clicker_user_id: 'telegram:scoped',
      approver_user_id: 'telegram:somebody-else',
      agent_group_id: ag.id,
    });

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('scoped-admin-override');
  });

  it('scoped admin of a DIFFERENT agent_group → not authorized', () => {
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    const ag1 = createAgentGroup({ name: 'G1', folder: 'g1' });
    const ag2 = createAgentGroup({ name: 'G2', folder: 'g2' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag1.id });

    const result = isAuthorizedClicker({
      clicker_user_id: 'telegram:scoped',
      approver_user_id: 'telegram:somebody-else',
      agent_group_id: ag2.id,
    });

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('not-approver-not-admin');
  });

  it('random user with no role and not the approver → not authorized', () => {
    ensureUser({ id: 'telegram:rando', kind: 'telegram' });

    const result = isAuthorizedClicker({
      clicker_user_id: 'telegram:rando',
      approver_user_id: 'telegram:approver',
      agent_group_id: 'group-1',
    });

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('not-approver-not-admin');
  });

  it('approver_user_id is null + clicker has no role → not authorized', () => {
    ensureUser({ id: 'telegram:rando', kind: 'telegram' });

    const result = isAuthorizedClicker({
      clicker_user_id: 'telegram:rando',
      approver_user_id: null,
      agent_group_id: 'group-1',
    });

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('not-approver-not-admin');
  });

  it('approver_user_id is null + clicker is owner → authorized via owner-override', () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const result = isAuthorizedClicker({
      clicker_user_id: 'telegram:owner',
      approver_user_id: null,
      agent_group_id: null,
    });

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('owner-override');
  });

  it('agent_group_id is null + scoped admin → not authorized (no scope to match)', () => {
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag.id });

    const result = isAuthorizedClicker({
      clicker_user_id: 'telegram:scoped',
      approver_user_id: 'telegram:somebody-else',
      agent_group_id: null,
    });

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('not-approver-not-admin');
  });
});

// ── handleApprovalClick (full pipeline) ────────────────────────────────────

describe('handleApprovalClick', () => {
  it('returns { success: false, reason: "approval-not-found" } when row missing', async () => {
    const result = await handleApprovalClick({
      approval_id: 'does-not-exist',
      clicker_user_id: 'telegram:alice',
      decision: 'approved',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('approval-not-found');
  });

  it('returns { success: false, reason: "already-approved" } when already resolved', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const { approvalId } = await requestApproval({
      action: 'install_packages',
      agentGroupId: ag.id,
      payload: {},
      originatingChannel: 'telegram',
    });
    updateApprovalStatus(approvalId, 'approved');

    const result = await handleApprovalClick({
      approval_id: approvalId,
      clicker_user_id: 'telegram:owner',
      decision: 'approved',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('already-approved');
  });

  it('authorized clicker + handler.applyDecision → handler called, status updated', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });

    const applyDecision = vi.fn();
    const handler: ApprovalHandler = {
      render: () => ({ title: 'T', body: 'B', options: [] }),
      applyDecision,
    };
    registerApprovalHandler('install_packages', handler);

    const { approvalId } = await requestApproval({
      action: 'install_packages',
      agentGroupId: ag.id,
      payload: { pkg: 'curl' },
      originatingChannel: 'telegram',
    });

    const result = await handleApprovalClick({
      approval_id: approvalId,
      clicker_user_id: 'telegram:owner',
      decision: 'approved',
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBe('approver-self');
    expect(applyDecision).toHaveBeenCalledTimes(1);
    expect(applyDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId,
        decision: 'approved',
        payload: expect.objectContaining({ pkg: 'curl' }),
      }),
    );

    const row = getPendingApproval(approvalId);
    expect(row!.status).toBe('approved');
  });

  it('admin override (non-approver) → applyDecision called, status updated', async () => {
    // Pick approver = owner, but the actual clicker is a global admin.
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    ensureUser({ id: 'telegram:admin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:admin', role: 'admin' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });

    const applyDecision = vi.fn();
    registerApprovalHandler('install_packages', {
      render: () => ({ title: 'T', body: 'B', options: [] }),
      applyDecision,
    });

    const { approvalId } = await requestApproval({
      action: 'install_packages',
      agentGroupId: ag.id,
      payload: {},
      originatingChannel: 'telegram',
    });

    const result = await handleApprovalClick({
      approval_id: approvalId,
      clicker_user_id: 'telegram:admin',
      decision: 'rejected',
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBe('global-admin-override');
    expect(applyDecision).toHaveBeenCalledTimes(1);
    expect(getPendingApproval(approvalId)!.status).toBe('rejected');
  });

  it('unauthorized clicker → status unchanged, applyDecision NOT called', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    ensureUser({ id: 'telegram:rando', kind: 'telegram' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const applyDecision = vi.fn();
    registerApprovalHandler('install_packages', {
      render: () => ({ title: 'T', body: 'B', options: [] }),
      applyDecision,
    });

    const { approvalId } = await requestApproval({
      action: 'install_packages',
      agentGroupId: ag.id,
      payload: {},
      originatingChannel: 'telegram',
    });

    const result = await handleApprovalClick({
      approval_id: approvalId,
      clicker_user_id: 'telegram:rando',
      decision: 'approved',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('not-approver-not-admin');
    expect(applyDecision).not.toHaveBeenCalled();
    expect(getPendingApproval(approvalId)!.status).toBe('pending');
  });

  it('handler.applyDecision throws → caught + logged, status still updated', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });

    registerApprovalHandler('install_packages', {
      render: () => ({ title: 'T', body: 'B', options: [] }),
      applyDecision: () => {
        throw new Error('handler explosion');
      },
    });

    const { approvalId } = await requestApproval({
      action: 'install_packages',
      agentGroupId: ag.id,
      payload: {},
      originatingChannel: 'telegram',
    });

    // Should NOT throw — the handler error is swallowed + logged.
    const result = await handleApprovalClick({
      approval_id: approvalId,
      clicker_user_id: 'telegram:owner',
      decision: 'approved',
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBe('approver-self');
    // Status is updated despite the handler explosion: the click-auth
    // contract is "the decision was recorded", not "the side effect ran".
    expect(getPendingApproval(approvalId)!.status).toBe('approved');
  });

  it('no handler registered for action → status updated, no throw', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const { approvalId } = await requestApproval({
      action: 'no_handler_action',
      agentGroupId: ag.id,
      payload: {},
      originatingChannel: 'telegram',
    });

    const result = await handleApprovalClick({
      approval_id: approvalId,
      clicker_user_id: 'telegram:owner',
      decision: 'approved',
    });

    expect(result.success).toBe(true);
    expect(getPendingApproval(approvalId)!.status).toBe('approved');
  });

  it('scoped admin clicks for THEIR agent_group → authorized', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });

    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag.id });

    const { approvalId } = await requestApproval({
      action: 'install_packages',
      agentGroupId: ag.id,
      payload: {},
      originatingChannel: 'telegram',
    });

    const result = await handleApprovalClick({
      approval_id: approvalId,
      clicker_user_id: 'telegram:scoped',
      decision: 'approved',
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBe('scoped-admin-override');
    expect(getPendingApproval(approvalId)!.status).toBe('approved');
  });
});
