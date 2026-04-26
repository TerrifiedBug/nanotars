import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getDb } from '../../db/init.js';
import {
  createAgentGroup,
  createMessagingGroup,
} from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import { isMember } from '../agent-group-members.js';
import {
  clearApprovalHandlers,
  getApprovalHandler,
  getPendingApproval,
} from '../approval-primitive.js';
import {
  SENDER_APPROVAL_ACTION,
  applySenderApprovalDecision,
  createPendingSenderApproval,
  deletePendingSenderApproval,
  getPendingSenderApproval,
  getPendingSenderApprovalById,
  getPendingSenderApprovalByApprovalId,
  hasInFlightSenderApproval,
  registerSenderApprovalHandler,
  requestSenderApproval,
} from '../sender-approval.js';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
});

/** Insert a stub pending_approvals row so pending_sender_approvals.approval_id
 *  has a valid FK target. The CRUD tests don't go through requestApproval
 *  (which would write the row for them); they exercise the DB layer directly,
 *  so we satisfy the FK manually with a minimal row. */
function seedPendingApproval(approvalId: string, agentGroupId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO pending_approvals (
        approval_id, request_id, action, payload, created_at,
        agent_group_id, status, title, options_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '', '[]')`,
    )
    .run(approvalId, approvalId, 'sender_approval', '{}', now, agentGroupId);
}

// ── DB-layer CRUD ──────────────────────────────────────────────────────────

describe('pending_sender_approvals CRUD', () => {
  it('createPendingSenderApproval round-trips a row by id and by (mg, sender)', () => {
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'group-1@g.us',
      name: 'Group 1',
    });
    ensureUser({ id: 'whatsapp:approver', kind: 'whatsapp' });
    seedPendingApproval('apv-1', ag.id);

    const inserted = createPendingSenderApproval({
      id: 'nsa-1',
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      sender_identity: 'whatsapp:stranger',
      sender_name: 'Stranger',
      original_message: 'hi',
      approver_user_id: 'whatsapp:approver',
      approval_id: 'apv-1',
      title: 'New sender',
      options_json: '[]',
    });
    expect(inserted).toBe(true);

    const byId = getPendingSenderApprovalById('nsa-1');
    expect(byId).toBeDefined();
    expect(byId!.sender_identity).toBe('whatsapp:stranger');

    const byPair = getPendingSenderApproval({
      messaging_group_id: mg.id,
      sender_identity: 'whatsapp:stranger',
    });
    expect(byPair?.id).toBe('nsa-1');

    const byApvId = getPendingSenderApprovalByApprovalId('apv-1');
    expect(byApvId?.id).toBe('nsa-1');

    expect(hasInFlightSenderApproval(mg.id, 'whatsapp:stranger')).toBe(true);

    deletePendingSenderApproval({ id: 'nsa-1' });
    expect(getPendingSenderApprovalById('nsa-1')).toBeUndefined();
    expect(hasInFlightSenderApproval(mg.id, 'whatsapp:stranger')).toBe(false);
  });

  it('UNIQUE(messaging_group_id, sender_identity) blocks duplicate inserts (returns false)', () => {
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'group-1@g.us',
      name: 'Group 1',
    });
    ensureUser({ id: 'whatsapp:approver', kind: 'whatsapp' });
    seedPendingApproval('apv-1', ag.id);

    const args = {
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      sender_identity: 'whatsapp:stranger',
      sender_name: 'Stranger',
      original_message: 'hi',
      approver_user_id: 'whatsapp:approver',
      approval_id: 'apv-1',
      title: '',
      options_json: '[]',
    };

    expect(createPendingSenderApproval({ ...args, id: 'nsa-1' })).toBe(true);
    expect(createPendingSenderApproval({ ...args, id: 'nsa-2' })).toBe(false);

    // Only the first row exists.
    const count = (getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM pending_sender_approvals WHERE messaging_group_id = ? AND sender_identity = ?`,
      )
      .get(mg.id, 'whatsapp:stranger') as { n: number }).n;
    expect(count).toBe(1);
  });
});

// ── requestSenderApproval flow ─────────────────────────────────────────────

describe('requestSenderApproval', () => {
  it('persists pending_approvals + pending_sender_approvals rows when an approver/DM exist', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const mg = createMessagingGroup({
      channel_type: 'telegram',
      platform_id: 'tg-chat-1',
      name: 'TG Chat 1',
    });

    const result = await requestSenderApproval({
      user_id: 'telegram:stranger',
      agent_group_id: ag.id,
      agent_group_folder: ag.folder,
      messaging_group_id: mg.id,
      sender_identity: 'telegram:stranger',
      display_name: 'Stranger Name',
      message_text: 'hello there',
      originating_channel: 'telegram',
    });

    expect(result.alreadyPending).toBe(false);
    expect(result.approvalId).toBeTruthy();

    // pending_approvals row written by 4C primitive
    const apv = getPendingApproval(result.approvalId);
    expect(apv).toBeDefined();
    expect(apv!.action).toBe(SENDER_APPROVAL_ACTION);
    expect(apv!.agent_group_id).toBe(ag.id);

    // pending_sender_approvals cross-reference row
    const psa = getPendingSenderApprovalByApprovalId(result.approvalId);
    expect(psa).toBeDefined();
    expect(psa!.messaging_group_id).toBe(mg.id);
    expect(psa!.sender_identity).toBe('telegram:stranger');
    expect(psa!.original_message).toBe('hello there');
    expect(psa!.approver_user_id).toBe('telegram:owner');
    expect(psa!.sender_name).toBe('Stranger Name');
  });

  it('idempotent: second call for same (mg, sender_identity) returns alreadyPending: true', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const mg = createMessagingGroup({
      channel_type: 'telegram',
      platform_id: 'tg-chat-1',
      name: 'TG Chat 1',
    });

    const first = await requestSenderApproval({
      user_id: 'telegram:stranger',
      agent_group_id: ag.id,
      agent_group_folder: ag.folder,
      messaging_group_id: mg.id,
      sender_identity: 'telegram:stranger',
      originating_channel: 'telegram',
    });
    expect(first.alreadyPending).toBe(false);

    const second = await requestSenderApproval({
      user_id: 'telegram:stranger',
      agent_group_id: ag.id,
      agent_group_folder: ag.folder,
      messaging_group_id: mg.id,
      sender_identity: 'telegram:stranger',
      originating_channel: 'telegram',
    });
    expect(second.alreadyPending).toBe(true);
    expect(second.approvalId).toBe(first.approvalId);

    // Only one pending_sender_approvals row exists for the pair.
    const count = (getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM pending_sender_approvals WHERE messaging_group_id = ? AND sender_identity = ?`,
      )
      .get(mg.id, 'telegram:stranger') as { n: number }).n;
    expect(count).toBe(1);
  });

  it('lazily creates the users row for the unknown sender (kind from channel prefix)', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const mg = createMessagingGroup({
      channel_type: 'telegram',
      platform_id: 'tg-chat-1',
      name: 'TG Chat 1',
    });

    await requestSenderApproval({
      user_id: 'telegram:newcomer',
      agent_group_id: ag.id,
      agent_group_folder: ag.folder,
      messaging_group_id: mg.id,
      sender_identity: 'telegram:newcomer',
      display_name: 'The Newcomer',
      originating_channel: 'telegram',
    });

    const u = getDb()
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get('telegram:newcomer') as { id: string; kind: string; display_name: string } | undefined;
    expect(u).toBeDefined();
    expect(u!.kind).toBe('telegram');
    expect(u!.display_name).toBe('The Newcomer');
  });

  it('skips writing pending_sender_approvals when no delivery target is available', async () => {
    // No owner/admin → no approver → no deliveryTarget.
    const ag = createAgentGroup({ name: 'Empty', folder: 'empty' });
    const mg = createMessagingGroup({
      channel_type: 'telegram',
      platform_id: 'tg-chat-1',
      name: 'TG Chat 1',
    });

    const result = await requestSenderApproval({
      user_id: 'telegram:stranger',
      agent_group_id: ag.id,
      agent_group_folder: ag.folder,
      messaging_group_id: mg.id,
      sender_identity: 'telegram:stranger',
      originating_channel: 'telegram',
    });

    // The 4C primitive still writes pending_approvals (with NULL channel)
    // so the action is auditable, but we did NOT write a
    // pending_sender_approvals row because there's no admin to receive
    // the card.
    expect(result.alreadyPending).toBe(false);
    expect(getPendingSenderApprovalByApprovalId(result.approvalId)).toBeUndefined();
  });
});

// ── Handler registration + applyDecision ──────────────────────────────────

describe('registerSenderApprovalHandler + applyDecision', () => {
  it('registers under SENDER_APPROVAL_ACTION', () => {
    registerSenderApprovalHandler();
    expect(getApprovalHandler(SENDER_APPROVAL_ACTION)).toBeDefined();
  });

  it('handler.render returns the expected card shape', () => {
    registerSenderApprovalHandler();
    const handler = getApprovalHandler(SENDER_APPROVAL_ACTION)!;
    const card = handler.render({
      approvalId: 'apv-1',
      payload: {
        display_name: 'Stranger',
        agent_group_folder: 'alpha',
      },
    });
    expect(card.title).toContain('New sender');
    expect(card.body).toContain('Stranger');
    expect(card.body).toContain('alpha');
    expect(card.options.map((o) => o.id)).toEqual(['approve', 'reject']);
  });

  it('applyDecision("approved") adds an agent_group_members row + deletes pending row', async () => {
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
      original_message: 'hi',
      approver_user_id: 'whatsapp:approver',
      approval_id: 'apv-1',
    });

    expect(isMember('whatsapp:newcomer', ag.id)).toBe(false);

    await applySenderApprovalDecision({
      approvalId: 'apv-1',
      payload: {},
      decision: 'approved',
    });

    expect(isMember('whatsapp:newcomer', ag.id)).toBe(true);
    expect(getPendingSenderApprovalById('nsa-1')).toBeUndefined();
  });

  it('applyDecision("rejected") does NOT add a member row, but does delete the pending row', async () => {
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
      original_message: 'hi',
      approver_user_id: 'whatsapp:approver',
      approval_id: 'apv-1',
    });

    await applySenderApprovalDecision({
      approvalId: 'apv-1',
      payload: {},
      decision: 'rejected',
    });

    expect(isMember('whatsapp:newcomer', ag.id)).toBe(false);
    expect(getPendingSenderApprovalById('nsa-1')).toBeUndefined();
  });

  it('applyDecision is idempotent on a missing pending_sender_approvals row (uses payload fallback)', async () => {
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    ensureUser({ id: 'whatsapp:newcomer', kind: 'whatsapp' });

    await applySenderApprovalDecision({
      approvalId: 'apv-orphan',
      payload: { user_id: 'whatsapp:newcomer', agent_group_id: ag.id },
      decision: 'approved',
    });

    expect(isMember('whatsapp:newcomer', ag.id)).toBe(true);
  });
});
