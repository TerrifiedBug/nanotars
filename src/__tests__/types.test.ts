import { describe, it, expectTypeOf } from 'vitest';
import type { Channel, ReplyContext } from '../types.js';

describe('Channel.openDM', () => {
  it('is an optional method that returns a Promise<string> (throws on failure)', () => {
    const ch: Channel = {
      name: 'test',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
      openDM: async (handle: string) => `${handle}@dm.test`,
    };
    // Exact-shape assertion: signature drift (e.g., re-introducing `| null`,
    // adding a parameter, returning a non-Promise) will fail this test.
    expectTypeOf(ch.openDM).toEqualTypeOf<((handle: string) => Promise<string>) | undefined>();
  });

  it('omitting openDM still satisfies Channel (backward compat)', () => {
    const ch: Channel = {
      name: 'test',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
    };
    expectTypeOf(ch.openDM).toEqualTypeOf<((handle: string) => Promise<string>) | undefined>();
  });
});

describe('Channel.extractReplyContext', () => {
  it('is an optional method that returns ReplyContext | null', () => {
    const ch: Channel = {
      name: 'test',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
      extractReplyContext: (raw) => null,
    };
    expectTypeOf(ch.extractReplyContext).toEqualTypeOf<((raw: unknown) => ReplyContext | null) | undefined>();
  });

  it('omitting extractReplyContext still satisfies Channel', () => {
    const ch: Channel = {
      name: 'test',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
    };
    expectTypeOf(ch.extractReplyContext).toEqualTypeOf<((raw: unknown) => ReplyContext | null) | undefined>();
  });
});
