import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getDb } from '../../db/init.js';
import {
  createAgentGroup,
  createMessagingGroup,
  getMessagingGroup,
  getAgentGroupByFolder,
  getWiringForMessagingGroup,
} from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import { isMember } from '../agent-group-members.js';
import {
  clearApprovalHandlers,
  getPendingApproval,
} from '../approval-primitive.js';
import {
  CHANNEL_APPROVAL_ACTION,
  createPendingChannelApproval,
  deletePendingChannelApproval,
  getPendingChannelApproval,
  getPendingChannelApprovalByApprovalId,
  isMessagingGroupDenied,
  registerChannelApprovalHandler,
  requestChannelApproval,
  setMessagingGroupDeniedAt,
} from '../channel-approval.js';
import { getApprovalHandler } from '../approval-primitive.js';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
});

// ── DB accessors ────────────────────────────────────────────────────────────

describe('pending_channel_approvals DB accessors', () => {
  it('createPendingChannelApproval writes a row and returns true', () => {
    const ag = createAgentGroup({ name: 'A', folder: 'a' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'chat@g.us',
      name: 'Chat',
    });
    // Owner row must exist before insert — pending_channel_approvals
    // has a FK on approver_user_id → users.id. approval_id is FK-nullable
    // so we leave it null in this DB-only smoke test (the request flow
    // tests below exercise the paired-row case).
    ensureUser({ id: 'whatsapp:owner', kind: 'whatsapp' });

    const ok = createPendingChannelApproval({
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      original_message: '{}',
      approver_user_id: 'whatsapp:owner',
      approval_id: null,
      title: 'New channel registration',
      options_json: '[]',
      created_at: new Date().toISOString(),
    });
    expect(ok).toBe(true);

    const row = getPendingChannelApproval(mg.id);
    expect(row).toBeDefined();
    expect(row!.agent_group_id).toBe(ag.id);
    expect(row!.approval_id).toBeNull();
  });

  it('createPendingChannelApproval returns false on PK collision (in-flight dedup)', () => {
    const ag = createAgentGroup({ name: 'A', folder: 'a' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'chat@g.us',
    });
    ensureUser({ id: 'whatsapp:owner', kind: 'whatsapp' });

    const seed = {
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      original_message: '{}',
      approver_user_id: 'whatsapp:owner',
      approval_id: null,
      title: '',
      options_json: '[]',
      created_at: new Date().toISOString(),
    };
    expect(createPendingChannelApproval(seed)).toBe(true);
    // Second insert is the dedup path — different fields, but PK collides.
    expect(createPendingChannelApproval({ ...seed, original_message: 'second' })).toBe(false);

    // First row preserved.
    expect(getPendingChannelApproval(mg.id)!.original_message).toBe('{}');
  });

  it('getPendingChannelApprovalByApprovalId looks up by paired approval_id', () => {
    const ag = createAgentGroup({ name: 'A', folder: 'a' });
    const mg = createMessagingGroup({ channel_type: 'whatsapp', platform_id: 'chat@g.us' });
    ensureUser({ id: 'whatsapp:owner', kind: 'whatsapp' });

    // approval_id is FK-nullable; for this CRUD smoke test we leave it null.
    createPendingChannelApproval({
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      original_message: '{}',
      approver_user_id: 'whatsapp:owner',
      approval_id: null,
      title: '',
      options_json: '[]',
      created_at: new Date().toISOString(),
    });

    // No paired approval_id, but the column is queryable for null lookups too.
    expect(getPendingChannelApprovalByApprovalId('nope')).toBeUndefined();
  });

  it('deletePendingChannelApproval removes the row', () => {
    const ag = createAgentGroup({ name: 'A', folder: 'a' });
    const mg = createMessagingGroup({ channel_type: 'whatsapp', platform_id: 'chat@g.us' });
    ensureUser({ id: 'whatsapp:owner', kind: 'whatsapp' });
    createPendingChannelApproval({
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      original_message: '{}',
      approver_user_id: 'whatsapp:owner',
      approval_id: null,
      title: '',
      options_json: '[]',
      created_at: new Date().toISOString(),
    });

    deletePendingChannelApproval(mg.id);
    expect(getPendingChannelApproval(mg.id)).toBeUndefined();
  });

  it('setMessagingGroupDeniedAt + isMessagingGroupDenied flip together', () => {
    const mg = createMessagingGroup({ channel_type: 'whatsapp', platform_id: 'chat@g.us' });
    expect(isMessagingGroupDenied(mg.id)).toBe(false);

    setMessagingGroupDeniedAt(mg.id, '2024-01-01T00:00:00.000Z');
    expect(isMessagingGroupDenied(mg.id)).toBe(true);
  });
});

// ── requestChannelApproval ──────────────────────────────────────────────────

async function seedOwnerWithDm(): Promise<string> {
  ensureUser({ id: 'telegram:owner', kind: 'telegram' });
  grantRole({ user_id: 'telegram:owner', role: 'owner' });
  await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
  return 'telegram:owner';
}

describe('requestChannelApproval', () => {
  it('happy path: writes pending row + paired approval, returns approvalId', async () => {
    await seedOwnerWithDm();
    createAgentGroup({ name: 'Existing', folder: 'existing' });

    const result = await requestChannelApproval({
      channel_type: 'telegram',
      platform_id: 'chat-99',
      chat_name: 'Some Chat',
    });

    expect(result.approvalId).toBeTruthy();
    expect(result.alreadyPending).toBe(false);
    expect(result.denied).toBe(false);

    // messaging_group was created on demand
    const mg = getMessagingGroup('telegram', 'chat-99');
    expect(mg).toBeDefined();

    // pending_channel_approvals row exists
    const row = getPendingChannelApproval(mg!.id);
    expect(row).toBeDefined();
    expect(row!.approval_id).toBe(result.approvalId);
    expect(row!.approver_user_id).toBe('telegram:owner');

    // paired pending_approvals row exists with our action
    const approval = getPendingApproval(result.approvalId);
    expect(approval).toBeDefined();
    expect(approval!.action).toBe(CHANNEL_APPROVAL_ACTION);
  });

  it('alreadyPending=true on second call for same messaging_group', async () => {
    await seedOwnerWithDm();
    createAgentGroup({ name: 'Existing', folder: 'existing' });

    const first = await requestChannelApproval({
      channel_type: 'telegram',
      platform_id: 'chat-99',
    });
    expect(first.alreadyPending).toBe(false);

    const second = await requestChannelApproval({
      channel_type: 'telegram',
      platform_id: 'chat-99',
    });
    expect(second.alreadyPending).toBe(true);
    expect(second.approvalId).toBe(first.approvalId);

    // Only one pending row written
    const mg = getMessagingGroup('telegram', 'chat-99')!;
    const row = getPendingChannelApproval(mg.id);
    expect(row!.approval_id).toBe(first.approvalId);
  });

  it('denied=true when messaging_groups.denied_at is set (sticky deny short-circuit)', async () => {
    await seedOwnerWithDm();
    createAgentGroup({ name: 'Existing', folder: 'existing' });

    const mg = createMessagingGroup({ channel_type: 'telegram', platform_id: 'chat-99' });
    setMessagingGroupDeniedAt(mg.id, '2024-01-01T00:00:00.000Z');

    const result = await requestChannelApproval({
      channel_type: 'telegram',
      platform_id: 'chat-99',
    });
    expect(result.denied).toBe(true);
    expect(result.approvalId).toBe('');
    // No pending row written
    expect(getPendingChannelApproval(mg.id)).toBeUndefined();
  });

  it('returns empty approvalId when no agent groups exist', async () => {
    await seedOwnerWithDm();
    // Note: no createAgentGroup — fresh-install case.

    const result = await requestChannelApproval({
      channel_type: 'telegram',
      platform_id: 'chat-99',
    });
    expect(result.approvalId).toBe('');
    expect(result.alreadyPending).toBe(false);
    expect(result.denied).toBe(false);
  });

  it('does not write 4D row when no approver / DM is reachable', async () => {
    // No owner / admin seeded; pickApprover returns [].
    createAgentGroup({ name: 'Existing', folder: 'existing' });

    const result = await requestChannelApproval({
      channel_type: 'telegram',
      platform_id: 'chat-99',
    });
    // 4C still creates a pending_approvals row (with NULL channel/platform_id);
    // 4D row is not created because deliveryTarget is undefined.
    expect(result.approvalId).toBeTruthy();

    const mg = getMessagingGroup('telegram', 'chat-99')!;
    expect(getPendingChannelApproval(mg.id)).toBeUndefined();
  });
});

// ── registerChannelApprovalHandler + applyDecision ──────────────────────────

describe('registerChannelApprovalHandler', () => {
  it('registers a handler under CHANNEL_APPROVAL_ACTION', () => {
    expect(getApprovalHandler(CHANNEL_APPROVAL_ACTION)).toBeUndefined();
    registerChannelApprovalHandler();
    const h = getApprovalHandler(CHANNEL_APPROVAL_ACTION);
    expect(h).toBeDefined();
    expect(typeof h!.render).toBe('function');
    expect(typeof h!.applyDecision).toBe('function');
  });

  it('render produces title + Approve/Reject options', () => {
    registerChannelApprovalHandler();
    const handler = getApprovalHandler(CHANNEL_APPROVAL_ACTION)!;
    const card = handler.render({
      approvalId: 'a',
      payload: {
        channel_type: 'telegram',
        platform_id: 'chat-99',
        messaging_group_id: 'mg-1',
        agent_group_id: 'ag-1',
      },
    });
    expect(card.title).toMatch(/channel registration/i);
    expect(card.options.map((o) => o.id)).toEqual(['approve', 'reject']);
  });

  it('applyDecision(approved) creates wiring + adds sender as first member', async () => {
    await seedOwnerWithDm();
    // We leave the proposed_folder unset, so applyDecision derives it
    // from the chat name. The folder is a fresh slug — applyDecision
    // creates a new agent group at that folder.
    createAgentGroup({ name: 'Existing', folder: 'existing' });
    registerChannelApprovalHandler();

    // Drive the full request → applyDecision('approved') flow.
    ensureUser({ id: 'telegram:senderJoe', kind: 'telegram' });
    const result = await requestChannelApproval({
      channel_type: 'telegram',
      platform_id: 'chat-99',
      chat_name: 'Some Chat',
      sender_user_id: 'telegram:senderJoe',
    });
    expect(result.approvalId).toBeTruthy();

    const mg = getMessagingGroup('telegram', 'chat-99')!;
    const handler = getApprovalHandler(CHANNEL_APPROVAL_ACTION)!;

    // Reconstruct the persisted payload (matches what applyDecision sees).
    const persisted = JSON.parse(getPendingApproval(result.approvalId)!.payload as string);

    await handler.applyDecision!({
      approvalId: result.approvalId,
      payload: persisted,
      decision: 'approved',
    });

    // Wiring was created.
    const wirings = getWiringForMessagingGroup(mg.id);
    expect(wirings).toHaveLength(1);
    expect(wirings[0].engage_mode).toBe('always');
    expect(wirings[0].sender_scope).toBe('known');
    expect(wirings[0].engage_pattern).toBe('.');

    // Folder derived from chat name.
    const newAg = getAgentGroupByFolder('some-chat');
    expect(newAg).toBeDefined();
    expect(wirings[0].agent_group_id).toBe(newAg!.id);

    // Sender added as a member (so the next message survives sender_scope='known').
    expect(isMember('telegram:senderJoe', newAg!.id)).toBe(true);

    // Pending channel approval row deleted on apply.
    expect(getPendingChannelApproval(mg.id)).toBeUndefined();

    // denied_at NOT set on approve.
    expect(isMessagingGroupDenied(mg.id)).toBe(false);
  });

  it('applyDecision(approved) creates a fresh agent group when proposed_folder is new', async () => {
    await seedOwnerWithDm();
    createAgentGroup({ name: 'Existing', folder: 'existing' });
    registerChannelApprovalHandler();

    const result = await requestChannelApproval({
      channel_type: 'telegram',
      platform_id: 'chat-99',
      proposed_folder: 'brand-new-folder',
    });
    const persisted = JSON.parse(getPendingApproval(result.approvalId)!.payload as string);
    const handler = getApprovalHandler(CHANNEL_APPROVAL_ACTION)!;
    await handler.applyDecision!({
      approvalId: result.approvalId,
      payload: persisted,
      decision: 'approved',
    });

    // Fresh agent group exists at the proposed folder.
    const fresh = getAgentGroupByFolder('brand-new-folder');
    expect(fresh).toBeDefined();
  });

  it('applyDecision(rejected) sets messaging_groups.denied_at and skips wiring', async () => {
    await seedOwnerWithDm();
    createAgentGroup({ name: 'Existing', folder: 'existing' });
    registerChannelApprovalHandler();

    const result = await requestChannelApproval({
      channel_type: 'telegram',
      platform_id: 'chat-99',
    });
    const mg = getMessagingGroup('telegram', 'chat-99')!;
    const persisted = JSON.parse(getPendingApproval(result.approvalId)!.payload as string);
    const handler = getApprovalHandler(CHANNEL_APPROVAL_ACTION)!;

    await handler.applyDecision!({
      approvalId: result.approvalId,
      payload: persisted,
      decision: 'rejected',
    });

    // Sticky deny set.
    expect(isMessagingGroupDenied(mg.id)).toBe(true);

    // No wiring created.
    expect(getWiringForMessagingGroup(mg.id)).toHaveLength(0);

    // Pending row deleted.
    expect(getPendingChannelApproval(mg.id)).toBeUndefined();

    // Future requestChannelApproval short-circuits on this messaging group.
    const second = await requestChannelApproval({
      channel_type: 'telegram',
      platform_id: 'chat-99',
    });
    expect(second.denied).toBe(true);
  });
});

// ── isMessagingGroupDenied ──────────────────────────────────────────────────

describe('isMessagingGroupDenied', () => {
  it('returns false when denied_at is NULL', () => {
    const mg = createMessagingGroup({ channel_type: 'whatsapp', platform_id: 'chat@g.us' });
    expect(isMessagingGroupDenied(mg.id)).toBe(false);
  });

  it('returns true after setMessagingGroupDeniedAt', () => {
    const mg = createMessagingGroup({ channel_type: 'whatsapp', platform_id: 'chat@g.us' });
    setMessagingGroupDeniedAt(mg.id, new Date().toISOString());
    expect(isMessagingGroupDenied(mg.id)).toBe(true);
  });

  it('returns false for unknown messaging_group_id', () => {
    expect(isMessagingGroupDenied('does-not-exist')).toBe(false);
  });
});
