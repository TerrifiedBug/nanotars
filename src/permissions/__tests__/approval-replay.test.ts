/**
 * Phase 4D D6 — replay-on-approve tests.
 *
 * Verifies that:
 *   - When the sender-approval handler's applyDecision('approved') runs,
 *     it invokes the registered replay hook with the original message
 *     text and platform routing.
 *   - When the channel-approval handler's applyDecision('approved') runs,
 *     it invokes the replay hook with the message_text from the
 *     persisted original_message JSON.
 *   - A 'rejected' decision does NOT invoke the replay hook.
 *   - A missing replay hook is a debug-level no-op (does not throw).
 *   - A replay hook that throws is caught + logged (does not roll back
 *     the membership change).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, getDb } from '../../db/init.js';
import {
  createAgentGroup,
  createMessagingGroup,
} from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import {
  clearApprovalHandlers,
} from '../approval-primitive.js';
import {
  clearReplayHook,
  getReplayHook,
  setReplayHook,
  type ReplayInboundArgs,
} from '../approval-replay.js';
import {
  applySenderApprovalDecision,
  createPendingSenderApproval,
} from '../sender-approval.js';
import {
  createPendingChannelApproval,
  registerChannelApprovalHandler,
} from '../channel-approval.js';
import { getApprovalHandler } from '../approval-primitive.js';
import { isMember } from '../agent-group-members.js';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
  clearReplayHook();
});

function seedPendingApproval(approvalId: string, agentGroupId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO pending_approvals (
        approval_id, request_id, action, payload, created_at,
        agent_group_id, status, title, options_json
      ) VALUES (?, ?, 'sender_approval', '{}', ?, ?, 'pending', '', '[]')`,
    )
    .run(approvalId, approvalId, now, agentGroupId);
}

describe('approval-replay registry', () => {
  it('setReplayHook + getReplayHook + clearReplayHook', () => {
    expect(getReplayHook()).toBeNull();
    const hook = vi.fn();
    setReplayHook(hook);
    expect(getReplayHook()).toBe(hook);
    clearReplayHook();
    expect(getReplayHook()).toBeNull();
  });
});

describe('sender-approval replay-on-approve', () => {
  it('invokes the replay hook with the original message after addMember', async () => {
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'g1@g.us',
      name: 'g1',
    });
    ensureUser({ id: 'whatsapp:approver', kind: 'whatsapp' });
    ensureUser({ id: 'whatsapp:newcomer', kind: 'whatsapp' });
    seedPendingApproval('apv-1', ag.id);
    createPendingSenderApproval({
      id: 'nsa-1',
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      sender_identity: 'whatsapp:newcomer',
      sender_name: 'Newcomer',
      original_message: 'please let me in',
      approver_user_id: 'whatsapp:approver',
      approval_id: 'apv-1',
    });

    const replayHook = vi.fn(async () => {});
    setReplayHook(replayHook);

    await applySenderApprovalDecision({
      approvalId: 'apv-1',
      payload: {},
      decision: 'approved',
    });

    expect(isMember('whatsapp:newcomer', ag.id)).toBe(true);
    expect(replayHook).toHaveBeenCalledTimes(1);
    const replayArgs = replayHook.mock.calls[0][0] as ReplayInboundArgs;
    expect(replayArgs.channel_type).toBe('whatsapp');
    expect(replayArgs.platform_id).toBe('g1@g.us');
    expect(replayArgs.sender_handle).toBe('newcomer');
    expect(replayArgs.sender_name).toBe('Newcomer');
    expect(replayArgs.message_text).toBe('please let me in');
    expect(replayArgs.agent_group_id).toBe(ag.id);
    expect(replayArgs.replay_id).toBe('sender-apv-1');
  });

  it('does NOT invoke the replay hook on a rejected decision', async () => {
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'g1@g.us',
      name: 'g1',
    });
    ensureUser({ id: 'whatsapp:approver', kind: 'whatsapp' });
    ensureUser({ id: 'whatsapp:newcomer', kind: 'whatsapp' });
    seedPendingApproval('apv-1', ag.id);
    createPendingSenderApproval({
      id: 'nsa-1',
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      sender_identity: 'whatsapp:newcomer',
      sender_name: 'Newcomer',
      original_message: 'please let me in',
      approver_user_id: 'whatsapp:approver',
      approval_id: 'apv-1',
    });

    const replayHook = vi.fn();
    setReplayHook(replayHook);

    await applySenderApprovalDecision({
      approvalId: 'apv-1',
      payload: {},
      decision: 'rejected',
    });

    expect(isMember('whatsapp:newcomer', ag.id)).toBe(false);
    expect(replayHook).not.toHaveBeenCalled();
  });

  it('does not throw when no hook is registered (best-effort)', async () => {
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'g1@g.us',
      name: 'g1',
    });
    ensureUser({ id: 'whatsapp:approver', kind: 'whatsapp' });
    ensureUser({ id: 'whatsapp:newcomer', kind: 'whatsapp' });
    seedPendingApproval('apv-1', ag.id);
    createPendingSenderApproval({
      id: 'nsa-1',
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      sender_identity: 'whatsapp:newcomer',
      sender_name: 'Newcomer',
      original_message: 'please let me in',
      approver_user_id: 'whatsapp:approver',
      approval_id: 'apv-1',
    });

    await expect(
      applySenderApprovalDecision({
        approvalId: 'apv-1',
        payload: {},
        decision: 'approved',
      }),
    ).resolves.toBeUndefined();

    // Membership change still happened.
    expect(isMember('whatsapp:newcomer', ag.id)).toBe(true);
  });

  it('catches a hook that throws — membership change persists', async () => {
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'g1@g.us',
      name: 'g1',
    });
    ensureUser({ id: 'whatsapp:approver', kind: 'whatsapp' });
    ensureUser({ id: 'whatsapp:newcomer', kind: 'whatsapp' });
    seedPendingApproval('apv-1', ag.id);
    createPendingSenderApproval({
      id: 'nsa-1',
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      sender_identity: 'whatsapp:newcomer',
      sender_name: 'Newcomer',
      original_message: 'please let me in',
      approver_user_id: 'whatsapp:approver',
      approval_id: 'apv-1',
    });

    setReplayHook(async () => {
      throw new Error('replay broke');
    });

    await applySenderApprovalDecision({
      approvalId: 'apv-1',
      payload: {},
      decision: 'approved',
    });

    expect(isMember('whatsapp:newcomer', ag.id)).toBe(true);
  });

  it('skips replay when original_message is empty (no-op, no error)', async () => {
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'g1@g.us',
      name: 'g1',
    });
    ensureUser({ id: 'whatsapp:approver', kind: 'whatsapp' });
    ensureUser({ id: 'whatsapp:newcomer', kind: 'whatsapp' });
    seedPendingApproval('apv-1', ag.id);
    createPendingSenderApproval({
      id: 'nsa-1',
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      sender_identity: 'whatsapp:newcomer',
      sender_name: 'Newcomer',
      original_message: '',
      approver_user_id: 'whatsapp:approver',
      approval_id: 'apv-1',
    });

    const replayHook = vi.fn();
    setReplayHook(replayHook);

    await applySenderApprovalDecision({
      approvalId: 'apv-1',
      payload: {},
      decision: 'approved',
    });

    expect(replayHook).not.toHaveBeenCalled();
  });
});

describe('channel-approval replay-on-approve', () => {
  it('invokes the replay hook with the message_text persisted on original_message', async () => {
    registerChannelApprovalHandler();
    const handler = getApprovalHandler('channel-approval')!;

    // Seed prerequisites for the handler.
    const ag = createAgentGroup({ name: 'NEW', folder: 'new-channel' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'wa-new@g.us',
      name: 'NEW',
    });
    ensureUser({ id: 'whatsapp:owner', kind: 'whatsapp' });
    ensureUser({ id: 'whatsapp:asker', kind: 'whatsapp' });
    seedPendingApproval('apv-1', ag.id);
    createPendingChannelApproval({
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      original_message: JSON.stringify({
        channel_type: 'whatsapp',
        platform_id: 'wa-new@g.us',
        chat_name: 'NEW',
        sender_user_id: 'whatsapp:asker',
        message_text: 'first message ever',
      }),
      approver_user_id: 'whatsapp:owner',
      approval_id: 'apv-1',
      title: '',
      options_json: '[]',
      created_at: new Date().toISOString(),
    });

    const replayHook = vi.fn(async () => {});
    setReplayHook(replayHook);

    const payload = {
      channel_type: 'whatsapp',
      platform_id: 'wa-new@g.us',
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      chat_name: 'NEW',
      sender_user_id: 'whatsapp:asker',
      proposed_folder: 'new-channel',
    };

    await handler.applyDecision!({
      approvalId: 'apv-1',
      payload,
      decision: 'approved',
    });

    expect(replayHook).toHaveBeenCalledTimes(1);
    const replayArgs = replayHook.mock.calls[0][0] as ReplayInboundArgs;
    expect(replayArgs.channel_type).toBe('whatsapp');
    expect(replayArgs.platform_id).toBe('wa-new@g.us');
    expect(replayArgs.sender_handle).toBe('asker');
    expect(replayArgs.message_text).toBe('first message ever');
    expect(replayArgs.replay_id).toBe('channel-apv-1');
  });

  it('skips replay when original_message has no message_text (legacy rows)', async () => {
    registerChannelApprovalHandler();
    const handler = getApprovalHandler('channel-approval')!;

    const ag = createAgentGroup({ name: 'NEW', folder: 'new-channel' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'wa-new@g.us',
      name: 'NEW',
    });
    ensureUser({ id: 'whatsapp:owner', kind: 'whatsapp' });
    seedPendingApproval('apv-1', ag.id);
    createPendingChannelApproval({
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      // No `message_text` field — pre-D6 row shape.
      original_message: JSON.stringify({
        channel_type: 'whatsapp',
        platform_id: 'wa-new@g.us',
        chat_name: 'NEW',
        sender_user_id: 'whatsapp:asker',
      }),
      approver_user_id: 'whatsapp:owner',
      approval_id: 'apv-1',
      title: '',
      options_json: '[]',
      created_at: new Date().toISOString(),
    });

    const replayHook = vi.fn();
    setReplayHook(replayHook);

    await handler.applyDecision!({
      approvalId: 'apv-1',
      payload: {
        channel_type: 'whatsapp',
        platform_id: 'wa-new@g.us',
        messaging_group_id: mg.id,
        agent_group_id: ag.id,
      },
      decision: 'approved',
    });

    expect(replayHook).not.toHaveBeenCalled();
  });
});
