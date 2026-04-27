import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../db/init.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { ensureUser } from '../permissions/users.js';
import { grantRole } from '../permissions/user-roles.js';
import { isAdminCommand, checkCommandPermission } from '../command-gate.js';

beforeEach(() => {
  _initTestDatabase();
});

// --- isAdminCommand ---

describe('isAdminCommand', () => {
  it('classifies /grant as admin', () => {
    expect(isAdminCommand('/grant')).toBe(true);
  });

  it('classifies /revoke as admin', () => {
    expect(isAdminCommand('/revoke')).toBe(true);
  });

  it('classifies /list-users as admin', () => {
    expect(isAdminCommand('/list-users')).toBe(true);
  });

  it('classifies /list-roles as admin', () => {
    expect(isAdminCommand('/list-roles')).toBe(true);
  });

  it('classifies /register-group as admin', () => {
    expect(isAdminCommand('/register-group')).toBe(true);
  });

  it('classifies /delete-group as admin', () => {
    expect(isAdminCommand('/delete-group')).toBe(true);
  });

  it('classifies /restart as admin', () => {
    expect(isAdminCommand('/restart')).toBe(true);
  });

  it('classifies /help as admin', () => {
    expect(isAdminCommand('/help')).toBe(true);
  });

  it('classifies /start as not admin', () => {
    expect(isAdminCommand('/start')).toBe(false);
  });

  it('classifies a plain message as not admin', () => {
    expect(isAdminCommand('Hello there')).toBe(false);
  });

  it('classifies command with args (/grant alice owner) as admin', () => {
    expect(isAdminCommand('/grant alice owner')).toBe(true);
  });

  it('classifies command with args (/revoke alice) as admin', () => {
    expect(isAdminCommand('/revoke alice')).toBe(true);
  });

  it('handles leading whitespace before command', () => {
    expect(isAdminCommand('  /grant alice')).toBe(true);
  });

  it('handles empty string', () => {
    expect(isAdminCommand('')).toBe(false);
  });

  it('handles whitespace-only string', () => {
    expect(isAdminCommand('   ')).toBe(false);
  });
});

// --- checkCommandPermission ---

describe('checkCommandPermission', () => {
  it('unauthenticated (userId undefined) → denied with reason "unauthenticated"', () => {
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const result = checkCommandPermission(undefined, '/grant', ag.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unauthenticated');
  });

  it('owner → allowed', () => {
    const ag = createAgentGroup({ name: 'Beta', folder: 'beta' });
    ensureUser({ id: 'telegram:owner1', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner1', role: 'owner' });

    const result = checkCommandPermission('telegram:owner1', '/grant', ag.id);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('owner');
  });

  it('global admin → allowed', () => {
    const ag = createAgentGroup({ name: 'Gamma', folder: 'gamma' });
    ensureUser({ id: 'telegram:gadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:gadmin', role: 'admin' }); // no agent_group_id → global

    const result = checkCommandPermission('telegram:gadmin', '/revoke', ag.id);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('global-admin');
  });

  it('scoped admin for this agent_group → allowed', () => {
    const ag = createAgentGroup({ name: 'Delta', folder: 'delta' });
    ensureUser({ id: 'telegram:sadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:sadmin', role: 'admin', agent_group_id: ag.id });

    const result = checkCommandPermission('telegram:sadmin', '/list-roles', ag.id);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('scoped-admin');
  });

  it('scoped admin for a different agent_group → denied', () => {
    const ag1 = createAgentGroup({ name: 'Epsilon', folder: 'epsilon' });
    const ag2 = createAgentGroup({ name: 'Zeta', folder: 'zeta' });
    ensureUser({ id: 'telegram:sadmin2', kind: 'telegram' });
    grantRole({ user_id: 'telegram:sadmin2', role: 'admin', agent_group_id: ag2.id });

    // sadmin2 is admin of ag2, not ag1
    const result = checkCommandPermission('telegram:sadmin2', '/grant', ag1.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('admin-only');
  });

  it('plain user with no role → denied with reason "admin-only"', () => {
    const ag = createAgentGroup({ name: 'Eta', folder: 'eta' });
    ensureUser({ id: 'telegram:norole', kind: 'telegram' });
    // no grantRole call

    const result = checkCommandPermission('telegram:norole', '/restart', ag.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('admin-only');
  });

  it('works for non-admin commands too (gate is not command-specific)', () => {
    const ag = createAgentGroup({ name: 'Theta', folder: 'theta' });
    ensureUser({ id: 'telegram:owner2', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner2', role: 'owner' });

    // checkCommandPermission doesn't filter on whether a command is admin-only;
    // that's isAdminCommand's job. This just checks if the user has admin rights.
    const result = checkCommandPermission('telegram:owner2', '/help', ag.id);
    expect(result.allowed).toBe(true);
  });
});

// --- metadata accessors ---

import { getAdminCommandMeta, listAdminCommands, type AdminCommandMeta } from '../command-gate.js';

describe('command-gate: metadata accessors', () => {
  it('returns metadata for known command', () => {
    const meta = getAdminCommandMeta('/grant');
    expect(meta).toBeDefined();
    expect(meta?.name).toBe('/grant');
    expect(meta?.description).toMatch(/grant/i);
  });

  it('returns undefined for unknown command', () => {
    expect(getAdminCommandMeta('/nope')).toBeUndefined();
  });

  it('listAdminCommands returns every entry sorted by name', () => {
    const list = listAdminCommands();
    const names = list.map((m) => m.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('/grant');
    expect(names).toContain('/help');
    expect(names).toContain('/pair-telegram');
  });

  it('every entry has non-empty description', () => {
    for (const meta of listAdminCommands()) {
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });
});
