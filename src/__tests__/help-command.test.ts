import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../command-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../command-gate.js')>();
  return {
    ...actual,
    checkCommandPermission: vi.fn(),
  };
});

import { checkCommandPermission } from '../command-gate.js';
import { tryHandleHelpCommand } from '../help-command.js';

describe('tryHandleHelpCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns handled=false for non-/help commands', () => {
    const result = tryHandleHelpCommand({
      command: '/grant',
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.handled).toBe(false);
    expect(result.reply).toBeUndefined();
  });

  it('refuses non-admin callers', () => {
    vi.mocked(checkCommandPermission).mockReturnValue({ allowed: false, reason: 'admin-only' });
    const result = tryHandleHelpCommand({
      command: '/help',
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/admin-only/i);
  });

  it('renders the full command list for admins', () => {
    vi.mocked(checkCommandPermission).mockReturnValue({ allowed: true, reason: 'owner' });
    const result = tryHandleHelpCommand({
      command: '/help',
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Admin commands');
    expect(result.reply).toContain('/grant');
    expect(result.reply).toContain('/help');
    expect(result.reply).toContain('/pair-telegram');
  });

  it('includes usage hints when present', () => {
    vi.mocked(checkCommandPermission).mockReturnValue({ allowed: true, reason: 'owner' });
    const result = tryHandleHelpCommand({
      command: '/help',
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.reply).toMatch(/\/grant <user_id> <role>/);
  });
});
