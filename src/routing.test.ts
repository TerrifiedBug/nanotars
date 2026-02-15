import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups, _setChannels } from './index.js';
import type { Channel } from './types.js';

/** Mock WhatsApp-like channel that owns @g.us and @s.whatsapp.net JIDs */
function mockWhatsAppChannel(): Channel {
  return {
    name: 'whatsapp',
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsJid: (jid: string) => jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net'),
    disconnect: async () => {},
  };
}

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
  _setChannels([mockWhatsAppChannel()]);
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });

  it('unknown JID format: does not match WhatsApp patterns', () => {
    const jid = 'unknown:12345';
    expect(jid.endsWith('@g.us')).toBe(false);
    expect(jid.endsWith('@s.whatsapp.net')).toBe(false);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only channel-owned JIDs', () => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:01.000Z', 'Group 1');
    storeChatMetadata('user@s.whatsapp.net', '2024-01-01T00:00:02.000Z', 'User DM');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:03.000Z', 'Group 2');
    storeChatMetadata('telegram:12345', '2024-01-01T00:00:04.000Z', 'Telegram Chat');

    const groups = getAvailableGroups();
    // WhatsApp channel owns @g.us and @s.whatsapp.net but not telegram:*
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => !g.jid.startsWith('telegram:'))).toBe(true);
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Group');

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata('reg@g.us', '2024-01-01T00:00:01.000Z', 'Registered');
    storeChatMetadata('unreg@g.us', '2024-01-01T00:00:02.000Z', 'Unregistered');

    _setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata('old@g.us', '2024-01-01T00:00:01.000Z', 'Old');
    storeChatMetadata('new@g.us', '2024-01-01T00:00:05.000Z', 'New');
    storeChatMetadata('mid@g.us', '2024-01-01T00:00:03.000Z', 'Mid');

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });

  it('returns empty when no channels are registered', () => {
    _setChannels([]);
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Group');

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
