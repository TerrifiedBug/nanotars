import { describe, it, expectTypeOf } from 'vitest';
import type { Channel } from '../types.js';

describe('Channel.openDM', () => {
  it('is an optional method that returns a JID', () => {
    const ch: Channel = {
      name: 'test',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
      openDM: async (handle: string) => `dm:${handle}@example`,
    };
    expectTypeOf(ch.openDM).toMatchTypeOf<((handle: string) => Promise<string | null>) | undefined>();
  });

  it('omitting openDM still satisfies Channel', () => {
    const ch: Channel = {
      name: 'test',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
    };
    expectTypeOf(ch.openDM).toMatchTypeOf<((handle: string) => Promise<string | null>) | undefined>();
  });
});
