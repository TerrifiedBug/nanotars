import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../command-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../command-gate.js')>();
  return {
    ...actual,
    checkCommandPermission: vi.fn(() => ({ allowed: true, reason: 'owner' })),
  };
});
vi.mock('../lifecycle.js', () => ({
  pausedGate: { pause: vi.fn(), resume: vi.fn() },
}));
vi.mock('../pending-codes.js', () => ({
  createPendingCode: vi.fn(async () => ({ code: '1234', expiresAt: 'never' })),
}));
vi.mock('../container-runner.js', () => ({
  buildAgentGroupImage: vi.fn(async () => 'tag-stub'),
}));

import { dispatchAdminCommand } from '../admin-command-dispatch.js';

describe('dispatchAdminCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes /help to help handler', async () => {
    const result = await dispatchAdminCommand({
      command: '/help',
      args: [],
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Admin commands');
  });

  it('routes /pause to lifecycle handler', async () => {
    const result = await dispatchAdminCommand({
      command: '/pause',
      args: [],
      rest: 'maintenance window',
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/paused/i);
  });

  it('routes /resume to lifecycle handler', async () => {
    const result = await dispatchAdminCommand({
      command: '/resume',
      args: [],
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/resumed/i);
  });

  it('routes /pair-telegram to pair handler', async () => {
    const result = await dispatchAdminCommand({
      command: '/pair-telegram',
      args: [],
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/Pairing code/);
  });

  it('returns handled=false for unknown command', async () => {
    const result = await dispatchAdminCommand({
      command: '/nope',
      args: [],
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.handled).toBe(false);
    expect(result.reply).toBeUndefined();
  });

  it('returns handled=false for /restart (no host-side handler yet)', async () => {
    const result = await dispatchAdminCommand({
      command: '/restart',
      args: [],
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.handled).toBe(false);
  });
});
