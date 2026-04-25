import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, getDb } from '../../db/init.js';
import { createMessagingGroup } from '../../db/agent-groups.js';
import { getUserDm, ensureUserDm, clearUserDm, type ChannelDmAdapter } from '../user-dms.js';

function seedUser(id: string, kind: string): void {
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, kind, null, new Date().toISOString());
}

beforeEach(() => {
  _initTestDatabase();
});

describe('getUserDm', () => {
  it('returns undefined when no user_dms row exists', () => {
    seedUser('whatsapp:14155551212', 'whatsapp');
    expect(getUserDm('whatsapp:14155551212', 'whatsapp')).toBeUndefined();
  });
});

describe('ensureUserDm — direct channel (whatsapp)', () => {
  it('creates a messaging_group and user_dms row using handle as chat_id', async () => {
    seedUser('whatsapp:14155551212', 'whatsapp');

    const mg = await ensureUserDm({ user_id: 'whatsapp:14155551212', channel_type: 'whatsapp' });

    expect(mg).toBeDefined();
    expect(mg!.channel_type).toBe('whatsapp');
    expect(mg!.platform_id).toBe('14155551212');

    // Verify user_dms row was written
    const cached = getUserDm('whatsapp:14155551212', 'whatsapp');
    expect(cached).toBeDefined();
    expect(cached!.id).toBe(mg!.id);
  });

  it('cache hit: second ensureUserDm returns the same messaging_group', async () => {
    seedUser('whatsapp:14155551212', 'whatsapp');

    const first = await ensureUserDm({ user_id: 'whatsapp:14155551212', channel_type: 'whatsapp' });
    const second = await ensureUserDm({ user_id: 'whatsapp:14155551212', channel_type: 'whatsapp' });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.id).toBe(first!.id);
  });

  it('reuses existing messaging_group if one already exists for (channel, platform_id)', async () => {
    seedUser('telegram:alice', 'telegram');

    // Pre-create the messaging_group that would match the user's handle
    const existing = createMessagingGroup({ channel_type: 'telegram', platform_id: 'alice', name: 'Alice DM' });

    const mg = await ensureUserDm({ user_id: 'telegram:alice', channel_type: 'telegram' });

    expect(mg).toBeDefined();
    expect(mg!.id).toBe(existing.id);
    expect(mg!.name).toBe('Alice DM');
  });
});

describe('ensureUserDm — indirect channel (discord)', () => {
  it('calls openDM with handle and creates messaging_group at returned chat_id', async () => {
    seedUser('discord:alice123', 'discord');

    const adapter: ChannelDmAdapter = {
      name: 'discord',
      openDM: vi.fn().mockResolvedValue('chat-id-123'),
    };

    const mg = await ensureUserDm({
      user_id: 'discord:alice123',
      channel_type: 'discord',
      channel_adapter: adapter,
    });

    expect(adapter.openDM).toHaveBeenCalledWith('alice123');
    expect(mg).toBeDefined();
    expect(mg!.channel_type).toBe('discord');
    expect(mg!.platform_id).toBe('chat-id-123');

    // Verify user_dms row was written
    const cached = getUserDm('discord:alice123', 'discord');
    expect(cached).toBeDefined();
    expect(cached!.id).toBe(mg!.id);
  });

  it('returns undefined and does not write a row when openDM throws', async () => {
    seedUser('discord:baduser', 'discord');

    const adapter: ChannelDmAdapter = {
      name: 'discord',
      openDM: vi.fn().mockRejectedValue(new Error('openDM network error')),
    };

    const mg = await ensureUserDm({
      user_id: 'discord:baduser',
      channel_type: 'discord',
      channel_adapter: adapter,
    });

    expect(mg).toBeUndefined();
    expect(getUserDm('discord:baduser', 'discord')).toBeUndefined();
  });

  it('returns undefined when adapter has no openDM method', async () => {
    seedUser('slack:bob', 'slack');

    const adapter: ChannelDmAdapter = { name: 'slack' }; // no openDM

    const mg = await ensureUserDm({
      user_id: 'slack:bob',
      channel_type: 'slack',
      channel_adapter: adapter,
    });

    expect(mg).toBeUndefined();
    expect(getUserDm('slack:bob', 'slack')).toBeUndefined();
  });

  it('returns undefined when no adapter is provided for an indirect channel', async () => {
    seedUser('discord:nonadapter', 'discord');

    const mg = await ensureUserDm({
      user_id: 'discord:nonadapter',
      channel_type: 'discord',
      // no channel_adapter
    });

    expect(mg).toBeUndefined();
  });
});

describe('ensureUserDm — malformed user.id', () => {
  it('returns undefined when user.id has no colon', async () => {
    const mg = await ensureUserDm({
      user_id: 'malformedid',
      channel_type: 'whatsapp',
    });

    expect(mg).toBeUndefined();
  });
});

describe('clearUserDm', () => {
  it('removes the user_dms row for (userId, channelType)', async () => {
    seedUser('whatsapp:14155551212', 'whatsapp');

    await ensureUserDm({ user_id: 'whatsapp:14155551212', channel_type: 'whatsapp' });
    expect(getUserDm('whatsapp:14155551212', 'whatsapp')).toBeDefined();

    clearUserDm('whatsapp:14155551212', 'whatsapp');

    expect(getUserDm('whatsapp:14155551212', 'whatsapp')).toBeUndefined();
  });

  it('is a no-op when no row exists', () => {
    // Should not throw
    expect(() => clearUserDm('whatsapp:nobody', 'whatsapp')).not.toThrow();
  });
});
