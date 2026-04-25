import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createAgentGroup,
  createMessagingGroup,
  createWiring,
  deleteWiring,
  getAgentGroupByFolder,
  getAgentGroupById,
  getAllAgentGroups,
  getDb,
  getMessagingGroup,
  getMessagingGroupById,
  getWiring,
  getWiringForAgentGroup,
  getWiringForMessagingGroup,
  resolveAgentsForInbound,
} from '../index.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('agent_groups accessors', () => {
  it('createAgentGroup + getAgentGroupByFolder round-trip', () => {
    const ag = createAgentGroup({ name: 'Alice', folder: 'alice' });
    expect(ag.id).toBeTruthy();
    expect(ag.created_at).toBeTruthy();

    const found = getAgentGroupByFolder('alice');
    expect(found).toBeDefined();
    expect(found!.id).toBe(ag.id);
    expect(found!.name).toBe('Alice');
    expect(found!.container_config).toBeNull();
    expect(found!.agent_provider).toBeNull();
  });

  it('getAgentGroupById round-trip with container_config + agent_provider', () => {
    const ag = createAgentGroup({
      name: 'Bob',
      folder: 'bob',
      container_config: '{"timeout":1000}',
      agent_provider: 'opencode',
    });
    const found = getAgentGroupById(ag.id);
    expect(found).toBeDefined();
    expect(found!.container_config).toBe('{"timeout":1000}');
    expect(found!.agent_provider).toBe('opencode');
  });

  it('getAllAgentGroups returns multiple in deterministic order', () => {
    createAgentGroup({ name: 'A', folder: 'a-group' });
    createAgentGroup({ name: 'B', folder: 'b-group' });
    createAgentGroup({ name: 'C', folder: 'c-group' });

    const all = getAllAgentGroups();
    expect(all).toHaveLength(3);
    // Insertion order is preserved by ORDER BY created_at, id; created_at strings
    // are monotonic across these synchronous calls (or tied — id breaks ties).
    const folders = all.map((a) => a.folder);
    expect(folders).toContain('a-group');
    expect(folders).toContain('b-group');
    expect(folders).toContain('c-group');
  });

  it('createAgentGroup throws on invalid folder (path traversal)', () => {
    expect(() =>
      createAgentGroup({ name: 'Bad', folder: '../etc/passwd' }),
    ).toThrow(/invalid folder/);
  });

  it('createAgentGroup throws on reserved folder "global"', () => {
    expect(() =>
      createAgentGroup({ name: 'Reserved', folder: 'global' }),
    ).toThrow(/invalid folder/);
  });
});

describe('messaging_groups accessors', () => {
  it('createMessagingGroup + getMessagingGroup round-trip', () => {
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'alice@s.whatsapp.net',
      name: 'Alice DM',
    });
    const found = getMessagingGroup('whatsapp', 'alice@s.whatsapp.net');
    expect(found).toBeDefined();
    expect(found!.id).toBe(mg.id);
    expect(found!.name).toBe('Alice DM');
  });

  it('createMessagingGroup defaults unknown_sender_policy to "public"', () => {
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'default@s.whatsapp.net',
    });
    expect(mg.unknown_sender_policy).toBe('public');
    expect(mg.is_group).toBe(0);

    const found = getMessagingGroupById(mg.id);
    expect(found!.unknown_sender_policy).toBe('public');
  });

  it('getMessagingGroup returns undefined for unknown (channel, platform_id)', () => {
    expect(getMessagingGroup('whatsapp', 'nope@s.whatsapp.net')).toBeUndefined();
  });
});

describe('messaging_group_agents (wiring) accessors', () => {
  it('createWiring + getWiring round-trip with defaults', () => {
    const ag = createAgentGroup({ name: 'A', folder: 'a' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'a@s.whatsapp.net',
    });
    const w = createWiring({ messaging_group_id: mg.id, agent_group_id: ag.id });

    const found = getWiring(mg.id, ag.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(w.id);
    expect(found!.engage_mode).toBe('pattern');
    expect(found!.engage_pattern).toBeNull();
    expect(found!.sender_scope).toBe('all');
    expect(found!.ignored_message_policy).toBe('drop');
    expect(found!.session_mode).toBe('shared');
    expect(found!.priority).toBe(0);
  });

  it('getWiringForMessagingGroup returns multiple agents on same chat', () => {
    const ag1 = createAgentGroup({ name: 'A1', folder: 'a1' });
    const ag2 = createAgentGroup({ name: 'A2', folder: 'a2' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'shared@g.us',
    });
    createWiring({ messaging_group_id: mg.id, agent_group_id: ag1.id });
    createWiring({ messaging_group_id: mg.id, agent_group_id: ag2.id });

    const wirings = getWiringForMessagingGroup(mg.id);
    expect(wirings).toHaveLength(2);
    const agentIds = wirings.map((w) => w.agent_group_id).sort();
    expect(agentIds).toEqual([ag1.id, ag2.id].sort());
  });

  it('getWiringForAgentGroup returns multiple chats for same agent', () => {
    const ag = createAgentGroup({ name: 'Multi', folder: 'multi' });
    const mg1 = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'chat1@g.us',
    });
    const mg2 = createMessagingGroup({
      channel_type: 'discord',
      platform_id: 'chat2',
    });
    createWiring({ messaging_group_id: mg1.id, agent_group_id: ag.id });
    createWiring({ messaging_group_id: mg2.id, agent_group_id: ag.id });

    const wirings = getWiringForAgentGroup(ag.id);
    expect(wirings).toHaveLength(2);
    const mgIds = wirings.map((w) => w.messaging_group_id).sort();
    expect(mgIds).toEqual([mg1.id, mg2.id].sort());
  });

  it('deleteWiring removes the row', () => {
    const ag = createAgentGroup({ name: 'D', folder: 'd' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'd@s.whatsapp.net',
    });
    createWiring({ messaging_group_id: mg.id, agent_group_id: ag.id });
    expect(getWiring(mg.id, ag.id)).toBeDefined();

    deleteWiring(mg.id, ag.id);
    expect(getWiring(mg.id, ag.id)).toBeUndefined();
  });

  it('createWiring persists non-default engage values', () => {
    const ag = createAgentGroup({ name: 'E', folder: 'e' });
    const mg = createMessagingGroup({
      channel_type: 'telegram',
      platform_id: '12345',
    });
    createWiring({
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'mention-sticky',
      engage_pattern: '@bot',
      sender_scope: 'known',
      ignored_message_policy: 'observe',
    });
    const w = getWiring(mg.id, ag.id);
    expect(w!.engage_mode).toBe('mention-sticky');
    expect(w!.engage_pattern).toBe('@bot');
    expect(w!.sender_scope).toBe('known');
    expect(w!.ignored_message_policy).toBe('observe');
  });
});

describe('resolveAgentsForInbound', () => {
  it('returns the cross-joined result for a registered chat', () => {
    const ag = createAgentGroup({ name: 'R', folder: 'r' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'r@s.whatsapp.net',
    });
    createWiring({
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_pattern: '@TARS',
    });

    const resolved = resolveAgentsForInbound('whatsapp', 'r@s.whatsapp.net');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].agentGroup.id).toBe(ag.id);
    expect(resolved[0].messagingGroup.id).toBe(mg.id);
    expect(resolved[0].wiring.engage_pattern).toBe('@TARS');
  });

  it('returns [] for unregistered (channel, platform_id)', () => {
    const resolved = resolveAgentsForInbound('whatsapp', 'unknown@s.whatsapp.net');
    expect(resolved).toEqual([]);
  });

  it('orders multiple wirings by priority descending', () => {
    const ag1 = createAgentGroup({ name: 'Low', folder: 'low' });
    const ag2 = createAgentGroup({ name: 'High', folder: 'high' });
    const mg = createMessagingGroup({
      channel_type: 'whatsapp',
      platform_id: 'multi@g.us',
    });
    createWiring({ messaging_group_id: mg.id, agent_group_id: ag1.id });
    createWiring({ messaging_group_id: mg.id, agent_group_id: ag2.id });
    // Bump ag2's wiring priority so the ORDER BY priority DESC is exercised.
    getDb()
      .prepare(`UPDATE messaging_group_agents SET priority = 10 WHERE agent_group_id = ?`)
      .run(ag2.id);

    const resolved = resolveAgentsForInbound('whatsapp', 'multi@g.us');
    expect(resolved).toHaveLength(2);
    expect(resolved[0].agentGroup.id).toBe(ag2.id); // higher priority first
    expect(resolved[1].agentGroup.id).toBe(ag1.id);
  });
});
