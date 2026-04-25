import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import { getUserById } from '../users.js';
import { resolveSender } from '../sender-resolver.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('resolveSender', () => {
  it('creates a users row if the sender has not been seen before', () => {
    const userId = resolveSender({
      channel: 'telegram',
      platform_id: 'group-123',
      sender_handle: 'alice',
    });

    expect(userId).toBe('telegram:alice');
    const user = getUserById('telegram:alice');
    expect(user).toBeDefined();
    expect(user!.id).toBe('telegram:alice');
    expect(user!.kind).toBe('telegram');
  });

  it('returns the same id for repeat calls (idempotent through ensureUser)', () => {
    const info = {
      channel: 'whatsapp',
      platform_id: 'jid@s.whatsapp.net',
      sender_handle: 'bob',
    };

    const id1 = resolveSender(info);
    const id2 = resolveSender(info);
    expect(id1).toBe(id2);
    expect(id1).toBe('whatsapp:bob');
  });

  it('updates display_name when a new name is provided', () => {
    // First call without a display_name.
    resolveSender({
      channel: 'telegram',
      platform_id: 'group-456',
      sender_handle: 'charlie',
    });

    // Second call with a display_name.
    resolveSender({
      channel: 'telegram',
      platform_id: 'group-456',
      sender_handle: 'charlie',
      sender_name: 'Charlie Brown',
    });

    const user = getUserById('telegram:charlie');
    expect(user).toBeDefined();
    expect(user!.display_name).toBe('Charlie Brown');
  });

  it('user.id format is exactly "<channel>:<sender_handle>"', () => {
    const cases: Array<{ channel: string; sender_handle: string; expected: string }> = [
      { channel: 'whatsapp', sender_handle: '1234567890', expected: 'whatsapp:1234567890' },
      { channel: 'discord', sender_handle: 'user#1234', expected: 'discord:user#1234' },
      { channel: 'slack', sender_handle: 'U01ABCDEF', expected: 'slack:U01ABCDEF' },
    ];

    for (const { channel, sender_handle, expected } of cases) {
      const userId = resolveSender({ channel, platform_id: 'irrelevant', sender_handle });
      expect(userId).toBe(expected);
    }
  });
});
