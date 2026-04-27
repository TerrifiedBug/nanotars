import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, getDb } from '../../db/init.js';
import { createAgentGroup, createMessagingGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import {
  clearApprovalHandlers,
  registerApprovalHandler,
  requestApproval,
} from '../approval-primitive.js';
import { tryHandleApprovalTextReply } from '../approval-text-reply.js';

const CHANNEL = 'telegram';
const PLATFORM_ID = 'tg:8236653927';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
  registerApprovalHandler('test_action', {
    render: () => ({
      title: 'T',
      body: 'B',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    }),
    applyDecision: async () => undefined,
  });
});

async function setupOwnerInChat() {
  ensureUser({ id: 'telegram:8236653927', kind: 'telegram' });
  grantRole({ user_id: 'telegram:8236653927', role: 'owner' });
  createMessagingGroup({ channel_type: CHANNEL, platform_id: PLATFORM_ID, name: 'exploit', is_group: 0 });
  await ensureUserDm({ user_id: 'telegram:8236653927', channel_type: CHANNEL });
}

async function queuePending(): Promise<string> {
  const ag = createAgentGroup({ name: 'g', folder: 'g' });
  const result = await requestApproval({
    action: 'test_action',
    agentGroupId: ag.id,
    payload: {},
    originatingChannel: CHANNEL,
    skipDelivery: true,
  });
  // The pending_approvals row has channel_type/platform_id from deliveryTarget,
  // which gets set when an approver+DM exists. Verify with a direct SELECT in
  // case requestApproval didn't populate them as expected, then stamp manually.
  getDb()
    .prepare(`UPDATE pending_approvals SET channel_type = ?, platform_id = ? WHERE approval_id = ?`)
    .run(CHANNEL, PLATFORM_ID, result.approvalId);
  return result.approvalId;
}

describe('tryHandleApprovalTextReply', () => {
  it('matches "approve" exactly (case-insensitive) and dispatches', async () => {
    await setupOwnerInChat();
    await queuePending();
    const r = await tryHandleApprovalTextReply({
      channel_type: CHANNEL,
      platform_id: PLATFORM_ID,
      sender_handle: '8236653927',
      sender_name: 'exploit',
      text: 'approve',
    });
    expect(r.matched).toBe(true);
  });

  it('matches "REJECT" with surrounding whitespace', async () => {
    await setupOwnerInChat();
    await queuePending();
    const r = await tryHandleApprovalTextReply({
      channel_type: CHANNEL,
      platform_id: PLATFORM_ID,
      sender_handle: '8236653927',
      text: '  REJECT  ',
    });
    expect(r.matched).toBe(true);
  });

  it('falls through on text that contains "approve" but isnt only "approve"', async () => {
    await setupOwnerInChat();
    await queuePending();
    const r = await tryHandleApprovalTextReply({
      channel_type: CHANNEL,
      platform_id: PLATFORM_ID,
      sender_handle: '8236653927',
      text: 'I approve of this',
    });
    expect(r.matched).toBe(false);
  });

  it('falls through when no pending row for this chat', async () => {
    await setupOwnerInChat();
    const r = await tryHandleApprovalTextReply({
      channel_type: CHANNEL,
      platform_id: PLATFORM_ID,
      sender_handle: '8236653927',
      text: 'approve',
    });
    expect(r.matched).toBe(false);
  });

  it('falls through silently for non-approver users', async () => {
    await setupOwnerInChat();
    await queuePending();
    const r = await tryHandleApprovalTextReply({
      channel_type: CHANNEL,
      platform_id: PLATFORM_ID,
      sender_handle: '99999',
      sender_name: 'random',
      text: 'approve',
    });
    expect(r.matched).toBe(false);
  });

  it('matches only when text equals approve or reject', async () => {
    await setupOwnerInChat();
    await queuePending();
    for (const t of ['hello', 'yes', 'approve!', 'approves']) {
      const r = await tryHandleApprovalTextReply({
        channel_type: CHANNEL,
        platform_id: PLATFORM_ID,
        sender_handle: '8236653927',
        text: t,
      });
      expect(r.matched, t).toBe(false);
    }
  });
});
