/**
 * Slice 7 — end-to-end: orchestrator-equivalent text-reply parsing.
 *
 * Drives a fake "approve" inbound through tryHandleApprovalTextReply,
 * asserts the pending approval transitions to approved + applyDecision runs.
 *
 * Complements the unit tests in src/permissions/__tests__/approval-text-reply.test.ts
 * which verify regex / fall-through behaviour. This E2E test verifies that the
 * full pipeline (text-reply → routeApprovalClick → handleApprovalClick →
 * applyDecision → status=approved) works end-to-end.
 */
import { it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase, getDb } from '../../db/init.js';
import { createAgentGroup, createMessagingGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../../permissions/users.js';
import { grantRole } from '../../permissions/user-roles.js';
import { ensureUserDm } from '../../permissions/user-dms.js';
import {
  clearApprovalHandlers,
  registerApprovalHandler,
  requestApproval,
} from '../../permissions/approval-primitive.js';
import { tryHandleApprovalTextReply } from '../../permissions/approval-text-reply.js';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
});

it('approve text-reply → applyDecision runs → status approved', async () => {
  ensureUser({ id: 'telegram:8236653927', kind: 'telegram' });
  grantRole({ user_id: 'telegram:8236653927', role: 'owner' });
  createMessagingGroup({
    channel_type: 'telegram',
    platform_id: 'tg:8236653927',
    name: 'exploit',
    is_group: 0,
  });
  await ensureUserDm({ user_id: 'telegram:8236653927', channel_type: 'telegram' });
  const ag = createAgentGroup({ name: 'g', folder: 'g' });

  const applySpy = vi.fn(async () => undefined);
  registerApprovalHandler('test_action', {
    render: () => ({
      title: 'T',
      body: 'B',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    }),
    applyDecision: applySpy,
  });

  const result = await requestApproval({
    action: 'test_action',
    agentGroupId: ag.id,
    payload: {},
    originatingChannel: 'telegram',
    skipDelivery: true,
  });

  // Stamp chat coords on the row so the pending-row lookup in
  // tryHandleApprovalTextReply finds a match for this chat.
  getDb()
    .prepare(
      `UPDATE pending_approvals
          SET channel_type = 'telegram', platform_id = 'tg:8236653927'
        WHERE approval_id = ?`,
    )
    .run(result.approvalId);

  const reply = await tryHandleApprovalTextReply({
    channel_type: 'telegram',
    platform_id: 'tg:8236653927',
    sender_handle: '8236653927',
    text: 'approve',
  });

  expect(reply.matched).toBe(true);
  expect(applySpy).toHaveBeenCalledOnce();
  const row = getDb()
    .prepare(`SELECT status FROM pending_approvals WHERE approval_id = ?`)
    .get(result.approvalId) as { status: string };
  expect(row.status).toBe('approved');
});
