import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase } from '../db/init.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { ensureUser } from '../permissions/users.js';
import { grantRole } from '../permissions/user-roles.js';
import { tryHandleLifecycleAdminCommand } from '../lifecycle-admin-commands.js';
import { pausedGate, _resetPausedGate } from '../lifecycle.js';
import { isAdminCommand } from '../command-gate.js';

beforeEach(() => {
  _initTestDatabase();
  _resetPausedGate();
});

afterEach(() => {
  _resetPausedGate();
});

describe('command-gate: /pause and /resume are admin commands', () => {
  it('isAdminCommand recognises /pause', () => {
    expect(isAdminCommand('/pause')).toBe(true);
  });

  it('isAdminCommand recognises /resume', () => {
    expect(isAdminCommand('/resume')).toBe(true);
  });

  it('isAdminCommand recognises /pause with trailing reason', () => {
    expect(isAdminCommand('/pause maintenance window')).toBe(true);
  });

  it('isAdminCommand does NOT match a non-admin command', () => {
    expect(isAdminCommand('/notacommand')).toBe(false);
  });
});

describe('tryHandleLifecycleAdminCommand', () => {
  it('returns { handled: false } for non-pause/resume commands', () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    const result = tryHandleLifecycleAdminCommand({
      command: '/grant',
      userId: 'telegram:owner',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(false);
  });

  it('denies /pause when user is not threaded (unauthenticated)', () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    const result = tryHandleLifecycleAdminCommand({
      command: '/pause',
      userId: undefined,
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('admin-only');
    expect(pausedGate.isPaused()).toBe(false);
  });

  it('denies /pause for a non-admin user', () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:rando', kind: 'telegram' });
    const result = tryHandleLifecycleAdminCommand({
      command: '/pause',
      userId: 'telegram:rando',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('admin-only');
    expect(pausedGate.isPaused()).toBe(false);
  });

  it('owner can /pause and /resume', () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const pauseResult = tryHandleLifecycleAdminCommand({
      command: '/pause',
      userId: 'telegram:owner',
      agentGroupId: ag.id,
    });
    expect(pauseResult.handled).toBe(true);
    expect(pauseResult.reply).toBe('Host paused.');
    expect(pausedGate.isPaused()).toBe(true);

    const resumeResult = tryHandleLifecycleAdminCommand({
      command: '/resume',
      userId: 'telegram:owner',
      agentGroupId: ag.id,
    });
    expect(resumeResult.handled).toBe(true);
    expect(resumeResult.reply).toBe('Host resumed.');
    expect(pausedGate.isPaused()).toBe(false);
  });

  it('global admin can /pause', () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:gadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:gadmin', role: 'admin' });

    const result = tryHandleLifecycleAdminCommand({
      command: '/pause',
      userId: 'telegram:gadmin',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.permissionReason).toBe('global-admin');
    expect(pausedGate.isPaused()).toBe(true);
  });

  it('scoped admin of THIS group can /pause', () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag.id });

    const result = tryHandleLifecycleAdminCommand({
      command: '/pause',
      userId: 'telegram:scoped',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.permissionReason).toBe('scoped-admin');
    expect(pausedGate.isPaused()).toBe(true);
  });

  it('scoped admin of a DIFFERENT group cannot /pause', () => {
    const ag1 = createAgentGroup({ name: 'A', folder: 'a' });
    const ag2 = createAgentGroup({ name: 'B', folder: 'b' });
    ensureUser({ id: 'telegram:other', kind: 'telegram' });
    grantRole({ user_id: 'telegram:other', role: 'admin', agent_group_id: ag2.id });

    const result = tryHandleLifecycleAdminCommand({
      command: '/pause',
      userId: 'telegram:other',
      agentGroupId: ag1.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('admin-only');
    expect(pausedGate.isPaused()).toBe(false);
  });

  it('reason is folded into the audit log via pausedGate (no observable change to reply)', () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const result = tryHandleLifecycleAdminCommand({
      command: '/pause',
      userId: 'telegram:owner',
      userHandle: 'owner',
      reason: 'maintenance window',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toBe('Host paused.');
    expect(pausedGate.isPaused()).toBe(true);
  });
});
