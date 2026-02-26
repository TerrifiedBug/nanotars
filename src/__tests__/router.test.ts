import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../secret-redact.js', () => ({
  redactSecrets: vi.fn((s: string) => s),
}));

import { isAuthError, routeOutbound, routeOutboundFile } from '../router.js';
import { redactSecrets } from '../secret-redact.js';
import type { Channel } from '../types.js';
import type { PluginRegistry } from '../plugin-loader.js';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: 'test',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    disconnect: vi.fn(),
    ...overrides,
  };
}

// --- isAuthError ---

describe('isAuthError', () => {
  const patterns = [
    'does not have access to claude',
    'oauth token has expired',
    'obtain a new token',
    'refresh your existing token',
    'authentication_error',
    'invalid_api_key',
    'please login again',
  ];

  it.each(patterns)('returns true for pattern: %s', (pattern) => {
    expect(isAuthError(`Error: ${pattern}`)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAuthError('OAUTH TOKEN HAS EXPIRED')).toBe(true);
    expect(isAuthError('Authentication_Error occurred')).toBe(true);
  });

  it('returns false for non-matching text', () => {
    expect(isAuthError('Everything is fine')).toBe(false);
    expect(isAuthError('Connection timeout')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isAuthError('')).toBe(false);
  });
});

// --- routeOutbound ---

describe('routeOutbound', () => {
  beforeEach(() => {
    vi.mocked(redactSecrets).mockImplementation((s: string) => s);
  });

  it('sends message to the correct channel', async () => {
    const ch = makeChannel();
    const result = await routeOutbound([ch], 'jid@test', 'hello');
    expect(result).toBe(true);
    expect(ch.sendMessage).toHaveBeenCalledWith('jid@test', 'hello', undefined, undefined);
  });

  it('returns false when no channel owns the JID', async () => {
    const ch = makeChannel({ ownsJid: vi.fn(() => false) });
    const result = await routeOutbound([ch], 'jid@test', 'hello');
    expect(result).toBe(false);
  });

  it('returns false when channel is disconnected', async () => {
    const ch = makeChannel({ isConnected: vi.fn(() => false) });
    const result = await routeOutbound([ch], 'jid@test', 'hello');
    expect(result).toBe(false);
  });

  it('passes sender and replyTo through', async () => {
    const ch = makeChannel();
    await routeOutbound([ch], 'jid@test', 'hi', 'Bot', 'msg-123');
    expect(ch.sendMessage).toHaveBeenCalledWith('jid@test', 'hi', 'Bot', 'msg-123');
  });

  it('calls redactSecrets on the outbound text', async () => {
    vi.mocked(redactSecrets).mockReturnValue('redacted-text');
    const ch = makeChannel();
    await routeOutbound([ch], 'jid@test', 'secret');
    expect(redactSecrets).toHaveBeenCalledWith('secret');
    expect(ch.sendMessage).toHaveBeenCalledWith('jid@test', 'redacted-text', undefined, undefined);
  });

  it('runs plugin outbound hooks', async () => {
    const ch = makeChannel();
    const registry = {
      runOutboundHooks: vi.fn(async (text: string) => `[hooked] ${text}`),
    } as unknown as PluginRegistry;
    await routeOutbound([ch], 'jid@test', 'msg', undefined, undefined, registry);
    expect(registry.runOutboundHooks).toHaveBeenCalledWith('msg', 'jid@test', 'test');
    expect(ch.sendMessage).toHaveBeenCalledWith('jid@test', '[hooked] msg', undefined, undefined);
  });

  it('suppresses message when hook returns empty string', async () => {
    const ch = makeChannel();
    const registry = {
      runOutboundHooks: vi.fn(async () => ''),
    } as unknown as PluginRegistry;
    const result = await routeOutbound([ch], 'jid@test', 'msg', undefined, undefined, registry);
    expect(result).toBe(true);
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it('picks the first matching channel from multiple', async () => {
    const ch1 = makeChannel({ name: 'whatsapp', ownsJid: vi.fn(() => false) });
    const ch2 = makeChannel({ name: 'telegram' });
    await routeOutbound([ch1, ch2], 'jid@test', 'hello');
    expect(ch1.sendMessage).not.toHaveBeenCalled();
    expect(ch2.sendMessage).toHaveBeenCalled();
  });
});

// --- routeOutboundFile ---

describe('routeOutboundFile', () => {
  it('sends file to the correct channel', async () => {
    const sendFile = vi.fn();
    const ch = makeChannel({ sendFile });
    const buf = Buffer.from('data');
    const result = await routeOutboundFile([ch], 'jid@test', buf, 'image/png', 'photo.png', 'caption');
    expect(result).toBe(true);
    expect(sendFile).toHaveBeenCalledWith('jid@test', buf, 'image/png', 'photo.png', 'caption');
  });

  it('returns false when channel has no sendFile', async () => {
    const ch = makeChannel();
    // Channel without sendFile — default makeChannel doesn't add it
    const result = await routeOutboundFile([ch], 'jid@test', Buffer.from('x'), 'text/plain', 'f.txt');
    expect(result).toBe(false);
  });

  it('returns false when channel is disconnected', async () => {
    const ch = makeChannel({
      sendFile: vi.fn(),
      isConnected: vi.fn(() => false),
    });
    const result = await routeOutboundFile([ch], 'jid@test', Buffer.from('x'), 'text/plain', 'f.txt');
    expect(result).toBe(false);
  });
});
