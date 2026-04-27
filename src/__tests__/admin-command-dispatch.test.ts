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
// Slice 8: register-group handler queries the agent-groups DB; mock so
// /pair-telegram + /register-group don't require a real DB connection.
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroupByFolder: vi.fn((folder: string) => ({
    id: 'ag-test',
    folder,
    name: folder,
  })),
  createAgentGroup: vi.fn((args: { folder: string; name: string }) => ({
    id: 'ag-test-new',
    folder: args.folder,
    name: args.name,
  })),
  getAllAgentGroups: vi.fn(() => [{ id: 'ag-test', folder: 'main', name: 'Main' }]),
}));
vi.mock('../group-init.js', () => ({
  initGroupFilesystem: vi.fn(),
}));
vi.mock('../db/init.js', () => ({
  // Most paths through the dispatcher don't query the DB directly; list-admin
  // does (for /list-users etc.) but those tests aren't in this suite. Stub
  // getDb to a permissive Proxy so any incidental call returns chainable
  // .prepare(...).all/.get/.run that yield empty arrays / no-ops.
  getDb: vi.fn(() => ({
    prepare: () => ({ all: () => [], get: () => undefined, run: () => undefined }),
  })),
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

  it('routes /pair-telegram (legacy alias) to register-group handler', async () => {
    const result = await dispatchAdminCommand({
      command: '/pair-telegram',
      args: [],
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/Pairing code/);
  });

  it('routes /register-group <folder> to register-group handler', async () => {
    const result = await dispatchAdminCommand({
      command: '/register-group',
      args: ['main'],
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

  it('routes /restart to restart handler (slice 8)', async () => {
    const result = await dispatchAdminCommand({
      command: '/restart',
      args: [],
      userId: 'u1',
      agentGroupId: 'ag1',
    });
    expect(result.handled).toBe(true);
    // Without restart deps wired, the handler reports the wiring issue.
    expect(result.reply).toMatch(/Restart unavailable|Restarted/);
  });
});
