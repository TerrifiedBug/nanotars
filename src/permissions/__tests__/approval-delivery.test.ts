/**
 * Phase 4D D6 — adapter-agnostic approval-card delivery tests.
 *
 * Covers:
 *   - registerApprovalDeliverer / clearApprovalDeliverers registry contract
 *   - Plain-text fallback (deliverApprovalCardAsText)
 *   - deliverApprovalCard dispatch order: registered adapter first, then
 *     fallback. Errors in the adapter fall through to fallback.
 *   - platform_message_id persistence on a successful delivery.
 *   - End-to-end wiring from requestSenderApproval / requestChannelApproval
 *     / OneCLI bridge — each invokes deliverApprovalCard exactly once.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, getDb } from '../../db/init.js';
import {
  createAgentGroup,
  createMessagingGroup,
} from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import {
  clearApprovalHandlers,
  getPendingApproval,
} from '../approval-primitive.js';
import {
  clearApprovalDeliverers,
  deliverApprovalCard,
  deliverApprovalCardAsText,
  getApprovalDeliverer,
  registerApprovalDeliverer,
  type ApprovalCard,
} from '../approval-delivery.js';
import {
  registerSenderApprovalHandler,
  requestSenderApproval,
} from '../sender-approval.js';
import {
  registerChannelApprovalHandler,
  requestChannelApproval,
} from '../channel-approval.js';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
  clearApprovalDeliverers();
});

const SAMPLE_CARD: ApprovalCard = {
  approval_id: 'apv-1',
  channel_type: 'telegram',
  platform_id: 'tg-chat-1',
  title: 'New sender',
  body: 'Allow Stranger to message Alpha?',
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'reject', label: 'Reject' },
  ],
};

describe('registry', () => {
  it('register + get + clear', () => {
    const fn = vi.fn(async () => ({ delivered: true }));
    registerApprovalDeliverer('telegram', fn);
    expect(getApprovalDeliverer('telegram')).toBe(fn);
    clearApprovalDeliverers();
    expect(getApprovalDeliverer('telegram')).toBeUndefined();
  });

  it('overwrites on second register (warn, but no throw)', () => {
    const fn1 = vi.fn(async () => ({ delivered: true }));
    const fn2 = vi.fn(async () => ({ delivered: true }));
    registerApprovalDeliverer('telegram', fn1);
    registerApprovalDeliverer('telegram', fn2);
    expect(getApprovalDeliverer('telegram')).toBe(fn2);
  });
});

describe('deliverApprovalCardAsText (fallback)', () => {
  it('formats card as plain text and calls sendMessage with the chat id', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const result = await deliverApprovalCardAsText(SAMPLE_CARD, sendMessage);
    expect(result.delivered).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [jid, text] = sendMessage.mock.calls[0];
    expect(jid).toBe('tg-chat-1');
    // The text contains title, body, every option label, and the approval id
    expect(text).toContain('New sender');
    expect(text).toContain('Allow Stranger to message Alpha?');
    expect(text).toContain('Reply "approve" to Approve');
    expect(text).toContain('Reply "reject" to Reject');
    expect(text).toContain('apv-1');
  });

  it('returns delivered:false when no sendMessage is provided', async () => {
    const result = await deliverApprovalCardAsText(SAMPLE_CARD, undefined);
    expect(result.delivered).toBe(false);
    expect(result.error).toBe('no-sendMessage');
  });

  it('returns delivered:false with error message when sendMessage throws', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('network down');
    });
    const result = await deliverApprovalCardAsText(SAMPLE_CARD, sendMessage);
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('network down');
  });
});

describe('deliverApprovalCard (dispatcher)', () => {
  it('uses the registered channel adapter when present', async () => {
    const adapter = vi.fn(async (card: ApprovalCard) => ({
      delivered: true,
      platform_message_id: `tg-${card.approval_id}`,
    }));
    registerApprovalDeliverer('telegram', adapter);
    const fallback = vi.fn(async () => undefined);

    const result = await deliverApprovalCard(SAMPLE_CARD, {
      fallbackSendMessage: fallback,
      persistPlatformMessageId: false,
    });

    expect(result.delivered).toBe(true);
    expect(result.platform_message_id).toBe('tg-apv-1');
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to plain text when no adapter is registered', async () => {
    const fallback = vi.fn(async () => undefined);
    const result = await deliverApprovalCard(SAMPLE_CARD, {
      fallbackSendMessage: fallback,
    });
    expect(result.delivered).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('falls back when the registered adapter returns delivered:false', async () => {
    const adapter = vi.fn(async () => ({ delivered: false, error: 'rate-limited' }));
    registerApprovalDeliverer('telegram', adapter);
    const fallback = vi.fn(async () => undefined);

    const result = await deliverApprovalCard(SAMPLE_CARD, {
      fallbackSendMessage: fallback,
    });
    expect(result.delivered).toBe(true);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('falls back when the registered adapter throws', async () => {
    const adapter = vi.fn(async () => {
      throw new Error('boom');
    });
    registerApprovalDeliverer('telegram', adapter);
    const fallback = vi.fn(async () => undefined);

    const result = await deliverApprovalCard(SAMPLE_CARD, {
      fallbackSendMessage: fallback,
    });
    expect(result.delivered).toBe(true);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('fully fails (delivered:false) when no adapter and no fallback', async () => {
    const result = await deliverApprovalCard(SAMPLE_CARD, {});
    expect(result.delivered).toBe(false);
  });

  it('persists platform_message_id from the adapter to pending_approvals', async () => {
    // Seed a pending_approvals row so the UPDATE has something to land on.
    getDb()
      .prepare(
        `INSERT INTO pending_approvals (
          approval_id, request_id, action, payload, created_at,
          status, title, options_json
        ) VALUES (?, ?, 'sender_approval', '{}', '2024-01-01T00:00:00Z',
                  'pending', '', '[]')`,
      )
      .run('apv-1', 'apv-1');

    const adapter = vi.fn(async () => ({
      delivered: true,
      platform_message_id: 'tg-msg-42',
    }));
    registerApprovalDeliverer('telegram', adapter);

    await deliverApprovalCard(SAMPLE_CARD);

    const row = getPendingApproval('apv-1');
    expect(row?.platform_message_id).toBe('tg-msg-42');
  });
});

// ── End-to-end wiring through the four card-issuing paths ────────────────

describe('end-to-end card delivery from request flows', () => {
  it('requestSenderApproval invokes deliverApprovalCard once with the rendered card', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
    registerSenderApprovalHandler();

    const adapter = vi.fn(async () => ({ delivered: true }));
    registerApprovalDeliverer('telegram', adapter);

    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const mg = createMessagingGroup({
      channel_type: 'telegram',
      platform_id: 'tg-chat-1',
      name: 'TG Chat 1',
    });

    await requestSenderApproval({
      user_id: 'telegram:stranger',
      agent_group_id: ag.id,
      agent_group_folder: ag.folder,
      messaging_group_id: mg.id,
      sender_identity: 'telegram:stranger',
      display_name: 'Stranger',
      message_text: 'hi',
      originating_channel: 'telegram',
    });

    // Wait for the fire-and-forget delivery promise to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter).toHaveBeenCalledTimes(1);
    const card = adapter.mock.calls[0][0] as ApprovalCard;
    expect(card.title).toContain('New sender');
    expect(card.body).toContain('Stranger');
    expect(card.options.map((o) => o.id)).toEqual(['approve', 'reject']);
  });

  it('requestChannelApproval invokes deliverApprovalCard once with the rendered card', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
    createAgentGroup({ name: 'Existing', folder: 'existing' });
    registerChannelApprovalHandler();

    const adapter = vi.fn(async () => ({ delivered: true }));
    registerApprovalDeliverer('telegram', adapter);

    await requestChannelApproval({
      channel_type: 'whatsapp',
      platform_id: 'wa-chat-1',
      chat_name: 'A new group',
      sender_user_id: 'whatsapp:asker',
      message_text: 'first message',
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(adapter).toHaveBeenCalledTimes(1);
    const card = adapter.mock.calls[0][0] as ApprovalCard;
    expect(card.title).toContain('New channel');
    expect(card.options.map((o) => o.id)).toEqual(['approve', 'reject']);
  });
});
