/**
 * Phase 4D D6 — host-side approval-click router tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import {
  createAgentGroup,
} from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import {
  clearApprovalHandlers,
  registerApprovalHandler,
  requestApproval,
} from '../approval-primitive.js';
import {
  classifyOptionAsDecision,
  routeApprovalClick,
} from '../approval-click-router.js';
import { isMember, addMember } from '../agent-group-members.js';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
});

describe('classifyOptionAsDecision', () => {
  it('treats approve/approved/allow/yes/ok as approved (case-insensitive)', () => {
    expect(classifyOptionAsDecision('approve')).toBe('approved');
    expect(classifyOptionAsDecision('Approved')).toBe('approved');
    expect(classifyOptionAsDecision('approve_member')).toBe('approved');
    expect(classifyOptionAsDecision('ALLOW')).toBe('approved');
    expect(classifyOptionAsDecision('yes')).toBe('approved');
    expect(classifyOptionAsDecision('OK')).toBe('approved');
  });

  it('treats anything else as rejected', () => {
    expect(classifyOptionAsDecision('reject')).toBe('rejected');
    expect(classifyOptionAsDecision('deny')).toBe('rejected');
    expect(classifyOptionAsDecision('no')).toBe('rejected');
    expect(classifyOptionAsDecision('cancel')).toBe('rejected');
    expect(classifyOptionAsDecision('')).toBe('rejected');
  });
});

// ── Full pipeline: routeApprovalClick → handleApprovalClick → applyDecision

async function seedApproval(args: {
  agentGroupId: string;
  approverUserId: string;
}): Promise<{ approvalId: string }> {
  registerApprovalHandler('test-action', {
    render: () => ({
      title: 'Test',
      body: 'Test body',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    }),
    applyDecision: () => {
      // marked side-effect via a member add in callers
    },
  });

  // Ensure user_dms cache hits so pickApprovalDelivery resolves.
  // (We bypass channel adapters by seeding user_dms directly.)
  const result = await requestApproval({
    action: 'test-action',
    agentGroupId: args.agentGroupId,
    payload: { user_id: 'telegram:newcomer' },
    originatingChannel: 'telegram',
  });
  return { approvalId: result.approvalId };
}

describe('routeApprovalClick', () => {
  it('returns approval-not-found when the row does not exist', async () => {
    const result = await routeApprovalClick({
      approval_id: 'no-such-id',
      clicker_channel: 'telegram',
      clicker_platform_id: 'tg-1',
      clicker_handle: 'admin',
      selected_option: 'approve',
    });
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('approval-not-found');
  });

  it('returns option-not-on-card when the option id is not in options_json', async () => {
    const ag = createAgentGroup({ name: 'A', folder: 'a' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    // Seed a user_dms entry directly so pickApprovalDelivery's cache pass hits.
    const { ensureUserDm } = await import('../user-dms.js');
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    const { approvalId } = await seedApproval({
      agentGroupId: ag.id,
      approverUserId: 'telegram:owner',
    });

    const result = await routeApprovalClick({
      approval_id: approvalId,
      clicker_channel: 'telegram',
      clicker_platform_id: 'tg-chat-1',
      clicker_handle: 'owner',
      selected_option: 'maybe', // not on the card
    });
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('option-not-on-card');
  });

  it('routes an approve click through to the registered applyDecision', async () => {
    const ag = createAgentGroup({ name: 'A', folder: 'a' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    ensureUser({ id: 'telegram:newcomer', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    const { ensureUserDm } = await import('../user-dms.js');
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    // Replace test-action with a handler whose applyDecision adds a member.
    clearApprovalHandlers();
    const applySpy = vi.fn(({ payload }) => {
      addMember({
        user_id: payload.user_id as string,
        agent_group_id: ag.id,
      });
    });
    registerApprovalHandler('test-action', {
      render: () => ({
        title: 'Test',
        body: 'Test body',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      }),
      applyDecision: applySpy,
    });

    const result = await requestApproval({
      action: 'test-action',
      agentGroupId: ag.id,
      payload: { user_id: 'telegram:newcomer' },
      originatingChannel: 'telegram',
    });

    const click = await routeApprovalClick({
      approval_id: result.approvalId,
      clicker_channel: 'telegram',
      clicker_platform_id: 'tg-chat-1',
      clicker_handle: 'owner',
      selected_option: 'approve',
    });

    expect(click.handled).toBe(true);
    expect(click.success).toBe(true);
    expect(click.decision).toBe('approved');
    expect(click.clicker_user_id).toBe('telegram:owner');
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(isMember('telegram:newcomer', ag.id)).toBe(true);
  });

  it('rejects an unauthorized clicker (not approver, not admin)', async () => {
    const ag = createAgentGroup({ name: 'A', folder: 'a' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    const { ensureUserDm } = await import('../user-dms.js');
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    const { approvalId } = await seedApproval({
      agentGroupId: ag.id,
      approverUserId: 'telegram:owner',
    });

    const result = await routeApprovalClick({
      approval_id: approvalId,
      clicker_channel: 'telegram',
      clicker_platform_id: 'tg-chat-1',
      clicker_handle: 'random-user',
      selected_option: 'approve',
    });
    expect(result.handled).toBe(true);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('not-approver-not-admin');
  });

  it('admin override: a global admin can act on a card picked for someone else', async () => {
    const ag = createAgentGroup({ name: 'A', folder: 'a' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    ensureUser({ id: 'whatsapp:globalAdmin', kind: 'whatsapp' });
    grantRole({ user_id: 'whatsapp:globalAdmin', role: 'admin' });
    const { ensureUserDm } = await import('../user-dms.js');
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    const { approvalId } = await seedApproval({
      agentGroupId: ag.id,
      approverUserId: 'telegram:owner',
    });

    const result = await routeApprovalClick({
      approval_id: approvalId,
      clicker_channel: 'whatsapp',
      clicker_platform_id: 'wa-1',
      clicker_handle: 'globalAdmin',
      selected_option: 'reject',
    });
    expect(result.handled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.reason).toBe('global-admin-override');
    expect(result.decision).toBe('rejected');
  });
});
