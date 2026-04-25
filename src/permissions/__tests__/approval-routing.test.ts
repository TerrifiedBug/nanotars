import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import { createAgentGroup, createMessagingGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm, type ChannelDmAdapter } from '../user-dms.js';
import { pickApprover, pickApprovalDelivery } from '../approval-routing.js';

beforeEach(() => {
  _initTestDatabase();
});

// ── pickApprover ─────────────────────────────────────────────────────────────

describe('pickApprover', () => {
  it('returns [] when there are no roles', () => {
    const ag = createAgentGroup({ name: 'EmptyGroup', folder: 'empty-group' });
    expect(pickApprover(ag.id)).toEqual([]);
    expect(pickApprover(null)).toEqual([]);
  });

  it('returns only the owner when only an owner exists', () => {
    ensureUser({ id: 'telegram:owner1', kind: 'telegram', display_name: 'Owner1' });
    grantRole({ user_id: 'telegram:owner1', role: 'owner' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const result = pickApprover(ag.id);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('telegram:owner1');
  });

  it('orders global admins before owners', () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    ensureUser({ id: 'discord:gadmin', kind: 'discord' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    grantRole({ user_id: 'discord:gadmin', role: 'admin' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const result = pickApprover(ag.id);

    expect(result.map((u) => u.id)).toEqual(['discord:gadmin', 'telegram:owner']);
  });

  it('orders scoped admins before global admins before owners', () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    ensureUser({ id: 'discord:gadmin', kind: 'discord' });
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    grantRole({ user_id: 'discord:gadmin', role: 'admin' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag.id });

    const result = pickApprover(ag.id);
    expect(result.map((u) => u.id)).toEqual([
      'telegram:scoped',
      'discord:gadmin',
      'telegram:owner',
    ]);
  });

  it('does not include scoped admins of OTHER agent groups', () => {
    ensureUser({ id: 'discord:gadmin', kind: 'discord' });
    ensureUser({ id: 'telegram:other', kind: 'telegram' });
    grantRole({ user_id: 'discord:gadmin', role: 'admin' });

    const target = createAgentGroup({ name: 'Target', folder: 'target' });
    const other = createAgentGroup({ name: 'Other', folder: 'other' });
    grantRole({ user_id: 'telegram:other', role: 'admin', agent_group_id: other.id });

    const result = pickApprover(target.id);
    expect(result.map((u) => u.id)).toEqual(['discord:gadmin']);
    expect(result.map((u) => u.id)).not.toContain('telegram:other');
  });

  it('deduplicates when a user holds multiple roles (global admin + owner)', () => {
    ensureUser({ id: 'telegram:multi', kind: 'telegram' });
    grantRole({ user_id: 'telegram:multi', role: 'admin' });
    grantRole({ user_id: 'telegram:multi', role: 'owner' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const result = pickApprover(ag.id);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('telegram:multi');
  });

  it('deduplicates when a user is both scoped-admin and global-admin (scoped wins position)', () => {
    ensureUser({ id: 'telegram:dual', kind: 'telegram' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:dual', role: 'admin' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    grantRole({ user_id: 'telegram:dual', role: 'admin', agent_group_id: ag.id });

    const result = pickApprover(ag.id);
    // dual appears once, in the scoped-admin slot
    expect(result.map((u) => u.id)).toEqual(['telegram:dual', 'telegram:owner']);
  });

  it('skips scoped admins when agentGroupId is null (returns globals + owners only)', () => {
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    ensureUser({ id: 'discord:gadmin', kind: 'discord' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag.id });
    grantRole({ user_id: 'discord:gadmin', role: 'admin' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const result = pickApprover(null);
    expect(result.map((u) => u.id)).toEqual(['discord:gadmin', 'telegram:owner']);
    expect(result.map((u) => u.id)).not.toContain('telegram:scoped');
  });
});

// ── pickApprovalDelivery ─────────────────────────────────────────────────────

describe('pickApprovalDelivery', () => {
  it('returns the cached DM in the originating channel first', async () => {
    ensureUser({ id: 'whatsapp:alice', kind: 'whatsapp' });
    grantRole({ user_id: 'whatsapp:alice', role: 'owner' });

    const dm = await ensureUserDm({ user_id: 'whatsapp:alice', channel_type: 'whatsapp' });
    expect(dm).toBeDefined();

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const approvers = pickApprover(ag.id);

    const target = await pickApprovalDelivery(approvers, 'whatsapp');
    expect(target).toBeDefined();
    expect(target!.userId).toBe('whatsapp:alice');
    expect(target!.messagingGroup.id).toBe(dm!.id);
  });

  it('falls back to a cached DM in a different channel when origin has no DM', async () => {
    // Approver only has a telegram DM cached, but originating channel is whatsapp.
    ensureUser({ id: 'telegram:bob', kind: 'telegram' });
    grantRole({ user_id: 'telegram:bob', role: 'owner' });
    const dm = await ensureUserDm({ user_id: 'telegram:bob', channel_type: 'telegram' });
    expect(dm).toBeDefined();

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const approvers = pickApprover(ag.id);

    const target = await pickApprovalDelivery(approvers, 'whatsapp');
    expect(target).toBeDefined();
    expect(target!.userId).toBe('telegram:bob');
    expect(target!.messagingGroup.id).toBe(dm!.id);
  });

  it('prefers an approver reachable on the originating channel over one reachable elsewhere', async () => {
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    ensureUser({ id: 'whatsapp:owner', kind: 'whatsapp' });

    // scoped admin (priority 1) is reachable only via telegram
    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag.id });
    await ensureUserDm({ user_id: 'telegram:scoped', channel_type: 'telegram' });

    // owner (priority 3) reachable via whatsapp — same channel as origin
    grantRole({ user_id: 'whatsapp:owner', role: 'owner' });
    const ownerDm = await ensureUserDm({ user_id: 'whatsapp:owner', channel_type: 'whatsapp' });

    const approvers = pickApprover(ag.id);

    // Origin = whatsapp → preferredChannelOrder puts whatsapp first, so the
    // owner's whatsapp DM wins even though the scoped admin is higher priority.
    const target = await pickApprovalDelivery(approvers, 'whatsapp');
    expect(target).toBeDefined();
    expect(target!.userId).toBe('whatsapp:owner');
    expect(target!.messagingGroup.id).toBe(ownerDm!.id);
  });

  it('returns the higher-priority approver when both share the originating channel', async () => {
    ensureUser({ id: 'whatsapp:scoped', kind: 'whatsapp' });
    ensureUser({ id: 'whatsapp:owner', kind: 'whatsapp' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    grantRole({ user_id: 'whatsapp:scoped', role: 'admin', agent_group_id: ag.id });
    grantRole({ user_id: 'whatsapp:owner', role: 'owner' });

    const scopedDm = await ensureUserDm({ user_id: 'whatsapp:scoped', channel_type: 'whatsapp' });
    await ensureUserDm({ user_id: 'whatsapp:owner', channel_type: 'whatsapp' });

    const approvers = pickApprover(ag.id);
    const target = await pickApprovalDelivery(approvers, 'whatsapp');
    expect(target).toBeDefined();
    expect(target!.userId).toBe('whatsapp:scoped');
    expect(target!.messagingGroup.id).toBe(scopedDm!.id);
  });

  it('returns undefined when no approvers have cached DMs and no adapters are provided', async () => {
    ensureUser({ id: 'whatsapp:lonely', kind: 'whatsapp' });
    grantRole({ user_id: 'whatsapp:lonely', role: 'owner' });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const approvers = pickApprover(ag.id);

    const target = await pickApprovalDelivery(approvers, 'whatsapp');
    expect(target).toBeUndefined();
  });

  it('lazily resolves a DM via the originating-channel adapter when nothing is cached', async () => {
    ensureUser({ id: 'discord:carol', kind: 'discord' });
    grantRole({ user_id: 'discord:carol', role: 'owner' });

    const adapter: ChannelDmAdapter = {
      name: 'discord',
      openDM: vi.fn().mockResolvedValue('chat-id-discord'),
    };

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const approvers = pickApprover(ag.id);

    const target = await pickApprovalDelivery(approvers, 'discord', { discord: adapter });
    expect(target).toBeDefined();
    expect(target!.userId).toBe('discord:carol');
    expect(target!.messagingGroup.channel_type).toBe('discord');
    expect(target!.messagingGroup.platform_id).toBe('chat-id-discord');
    expect(adapter.openDM).toHaveBeenCalledWith('carol');
  });

  it('does not call openDM for an approver whose kind does not match the channel', async () => {
    // Approver is a Discord user; the only adapter on offer is for WhatsApp.
    // We must not try to DM the Discord user via WhatsApp.
    ensureUser({ id: 'discord:dave', kind: 'discord' });
    grantRole({ user_id: 'discord:dave', role: 'owner' });

    const whatsappAdapter: ChannelDmAdapter = {
      name: 'whatsapp',
      openDM: vi.fn().mockResolvedValue('should-not-be-called'),
    };

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const approvers = pickApprover(ag.id);

    const target = await pickApprovalDelivery(approvers, 'whatsapp', { whatsapp: whatsappAdapter });
    expect(target).toBeUndefined();
    expect(whatsappAdapter.openDM).not.toHaveBeenCalled();
  });

  it('checks all cached DMs before falling back to adapter resolution', async () => {
    // Approver has a telegram DM cached; origin is whatsapp.
    // We expect the cached telegram DM to win over a fresh adapter-resolved one.
    ensureUser({ id: 'telegram:eve', kind: 'telegram' });
    grantRole({ user_id: 'telegram:eve', role: 'owner' });
    const cachedDm = await ensureUserDm({ user_id: 'telegram:eve', channel_type: 'telegram' });

    const whatsappAdapter: ChannelDmAdapter = {
      name: 'whatsapp',
      openDM: vi.fn(),
    };

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const approvers = pickApprover(ag.id);

    const target = await pickApprovalDelivery(approvers, 'whatsapp', { whatsapp: whatsappAdapter });
    expect(target).toBeDefined();
    expect(target!.messagingGroup.id).toBe(cachedDm!.id);
    expect(whatsappAdapter.openDM).not.toHaveBeenCalled();
  });

  it('reuses an existing messaging_group when ensureUserDm finds a match', async () => {
    ensureUser({ id: 'whatsapp:frank', kind: 'whatsapp' });
    grantRole({ user_id: 'whatsapp:frank', role: 'owner' });

    // Pre-create the messaging group (whatsapp is direct: handle == platform_id)
    const existing = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'frank',
      name: 'Frank DM',
    });

    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const approvers = pickApprover(ag.id);

    // direct channel → no adapter needed for ensureUserDm
    const target = await pickApprovalDelivery(approvers, 'whatsapp', { whatsapp: { name: 'whatsapp' } });
    expect(target).toBeDefined();
    expect(target!.messagingGroup.id).toBe(existing.id);
  });

  it('returns undefined when approvers list is empty', async () => {
    const target = await pickApprovalDelivery([], 'whatsapp');
    expect(target).toBeUndefined();
  });
});
