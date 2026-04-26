import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase } from '../db/init.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { ensureUser } from '../permissions/users.js';
import { grantRole } from '../permissions/user-roles.js';
import { isAdminCommand } from '../command-gate.js';
import { tryHandlePairAdminCommand } from '../pair-admin-command.js';
import { _setStorePathForTest, getPendingCodeStatus } from '../pending-codes.js';

let tmpDir: string;

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-admin-test-'));
  _setStorePathForTest(path.join(tmpDir, 'pending-codes.json'));
});

afterEach(() => {
  _setStorePathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('command-gate: /pair-telegram is an admin command', () => {
  it('isAdminCommand recognises /pair-telegram', () => {
    expect(isAdminCommand('/pair-telegram')).toBe(true);
  });
});

describe('tryHandlePairAdminCommand', () => {
  it('returns { handled: false } for non-pair commands', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    const result = await tryHandlePairAdminCommand({
      command: '/grant',
      userId: 'telegram:owner',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(false);
  });

  it('denies /pair-telegram for unauthenticated callers', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    const result = await tryHandlePairAdminCommand({
      command: '/pair-telegram',
      userId: undefined,
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('admin-only');
    expect(result.permissionReason).toBe('unauthenticated');
  });

  it('denies /pair-telegram for non-admin users', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:rando', kind: 'telegram' });
    const result = await tryHandlePairAdminCommand({
      command: '/pair-telegram',
      userId: 'telegram:rando',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('admin-only');
  });

  it('owner can /pair-telegram and gets a 4-digit code', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const result = await tryHandlePairAdminCommand({
      command: '/pair-telegram',
      userId: 'telegram:owner',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.permissionReason).toBe('owner');
    expect(result.reply).toMatch(/Pairing code: \d{4}/);
    const code = result.reply!.match(/Pairing code: (\d{4})/)![1];
    expect(getPendingCodeStatus(code).status).toBe('pending');
  });

  it('global admin can /pair-telegram', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:gadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:gadmin', role: 'admin' });

    const result = await tryHandlePairAdminCommand({
      command: '/pair-telegram',
      userId: 'telegram:gadmin',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.permissionReason).toBe('global-admin');
    expect(result.reply).toMatch(/Pairing code: \d{4}/);
  });

  it('scoped admin of THIS group can /pair-telegram', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag.id });

    const result = await tryHandlePairAdminCommand({
      command: '/pair-telegram',
      userId: 'telegram:scoped',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.permissionReason).toBe('scoped-admin');
    expect(result.reply).toMatch(/Pairing code: \d{4}/);
  });

  it('scoped admin of a DIFFERENT group cannot /pair-telegram', async () => {
    const ag1 = createAgentGroup({ name: 'A', folder: 'a' });
    const ag2 = createAgentGroup({ name: 'B', folder: 'b' });
    ensureUser({ id: 'telegram:other', kind: 'telegram' });
    grantRole({ user_id: 'telegram:other', role: 'admin', agent_group_id: ag2.id });

    const result = await tryHandlePairAdminCommand({
      command: '/pair-telegram',
      userId: 'telegram:other',
      agentGroupId: ag1.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('admin-only');
  });

  it('reply includes operator instructions', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const result = await tryHandlePairAdminCommand({
      command: '/pair-telegram',
      userId: 'telegram:owner',
      agentGroupId: ag.id,
    });
    expect(result.reply).toContain('Telegram chat you want to register');
  });
});
