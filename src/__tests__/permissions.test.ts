import { describe, it, expect } from 'vitest';
import { resolveSender, canAccessAgentGroup } from '../permissions.js';

describe('permissions stubs (Phase 4A)', () => {
  it('resolveSender returns undefined', () => {
    expect(
      resolveSender({
        channel: 'whatsapp',
        platform_id: 'x@s.whatsapp.net',
        sender_handle: 'y',
      }),
    ).toBeUndefined();
  });

  it('resolveSender returns undefined even with full SenderInfo', () => {
    expect(
      resolveSender({
        channel: 'discord',
        platform_id: 'dc:123',
        sender_handle: 'user-handle',
        sender_name: 'Display Name',
      }),
    ).toBeUndefined();
  });

  it('canAccessAgentGroup returns true with no userId', () => {
    expect(canAccessAgentGroup(undefined, 'agent-group-id')).toBe(true);
  });

  it('canAccessAgentGroup returns true with a userId', () => {
    expect(canAccessAgentGroup('user-id', 'agent-group-id')).toBe(true);
  });
});
