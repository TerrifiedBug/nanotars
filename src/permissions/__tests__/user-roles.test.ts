import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import {
  grantRole,
  isOwner,
  isGlobalAdmin,
  isAdminOfAgentGroup,
  revokeRole,
  listOwners,
  listGlobalAdmins,
  listAdminsOfAgentGroup,
} from '../user-roles.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('grantRole + isOwner', () => {
  it('round-trip: grantRole owner then isOwner returns true', () => {
    ensureUser({ id: 'telegram:alice', kind: 'telegram' });
    grantRole({ user_id: 'telegram:alice', role: 'owner' });
    expect(isOwner('telegram:alice')).toBe(true);
  });

  it('isOwner returns false for a user with no role', () => {
    ensureUser({ id: 'telegram:nobody', kind: 'telegram' });
    expect(isOwner('telegram:nobody')).toBe(false);
  });

  it('rejects owner role with non-null agent_group_id (throws)', () => {
    ensureUser({ id: 'telegram:bad', kind: 'telegram' });
    const ag = createAgentGroup({ name: 'TestGroup', folder: 'test-group' });
    expect(() =>
      grantRole({ user_id: 'telegram:bad', role: 'owner', agent_group_id: ag.id }),
    ).toThrow('owner role must be global');
  });
});

describe('isGlobalAdmin', () => {
  it('recognizes role=admin AND agent_group_id IS NULL', () => {
    ensureUser({ id: 'discord:bob', kind: 'discord' });
    grantRole({ user_id: 'discord:bob', role: 'admin' });
    expect(isGlobalAdmin('discord:bob')).toBe(true);
  });

  it('does not count scoped admin as global admin', () => {
    ensureUser({ id: 'discord:carol', kind: 'discord' });
    const ag = createAgentGroup({ name: 'ScopedGroup', folder: 'scoped-group' });
    grantRole({ user_id: 'discord:carol', role: 'admin', agent_group_id: ag.id });
    expect(isGlobalAdmin('discord:carol')).toBe(false);
  });

  it('returns false for owner (not admin)', () => {
    ensureUser({ id: 'discord:dave', kind: 'discord' });
    grantRole({ user_id: 'discord:dave', role: 'owner' });
    expect(isGlobalAdmin('discord:dave')).toBe(false);
  });
});

describe('isAdminOfAgentGroup', () => {
  it('recognizes role=admin AND agent_group_id matches', () => {
    ensureUser({ id: 'telegram:eve', kind: 'telegram' });
    const ag = createAgentGroup({ name: 'EvesGroup', folder: 'eves-group' });
    grantRole({ user_id: 'telegram:eve', role: 'admin', agent_group_id: ag.id });
    expect(isAdminOfAgentGroup('telegram:eve', ag.id)).toBe(true);
  });

  it('returns false when agent_group_id does not match', () => {
    ensureUser({ id: 'telegram:frank', kind: 'telegram' });
    const ag1 = createAgentGroup({ name: 'Group1', folder: 'group-1' });
    const ag2 = createAgentGroup({ name: 'Group2', folder: 'group-2' });
    grantRole({ user_id: 'telegram:frank', role: 'admin', agent_group_id: ag1.id });
    expect(isAdminOfAgentGroup('telegram:frank', ag2.id)).toBe(false);
  });

  it('global admin is NOT automatically an agent group admin via isAdminOfAgentGroup', () => {
    // isAdminOfAgentGroup checks the exact row, not privilege transitivity
    ensureUser({ id: 'telegram:grace', kind: 'telegram' });
    const ag = createAgentGroup({ name: 'GraceGroup', folder: 'grace-group' });
    grantRole({ user_id: 'telegram:grace', role: 'admin' }); // global
    expect(isAdminOfAgentGroup('telegram:grace', ag.id)).toBe(false);
  });
});

describe('revokeRole', () => {
  it('removes the owner row so isOwner returns false after revoke', () => {
    ensureUser({ id: 'telegram:henry', kind: 'telegram' });
    grantRole({ user_id: 'telegram:henry', role: 'owner' });
    expect(isOwner('telegram:henry')).toBe(true);

    revokeRole({ user_id: 'telegram:henry', role: 'owner' });
    expect(isOwner('telegram:henry')).toBe(false);
  });

  it('removes a scoped admin row', () => {
    ensureUser({ id: 'discord:ida', kind: 'discord' });
    const ag = createAgentGroup({ name: 'IdasGroup', folder: 'idas-group' });
    grantRole({ user_id: 'discord:ida', role: 'admin', agent_group_id: ag.id });
    expect(isAdminOfAgentGroup('discord:ida', ag.id)).toBe(true);

    revokeRole({ user_id: 'discord:ida', role: 'admin', agent_group_id: ag.id });
    expect(isAdminOfAgentGroup('discord:ida', ag.id)).toBe(false);
  });

  it('does not revoke scoped admin when revoking global admin (different rows)', () => {
    ensureUser({ id: 'discord:jack', kind: 'discord' });
    const ag = createAgentGroup({ name: 'JacksGroup', folder: 'jacks-group' });
    grantRole({ user_id: 'discord:jack', role: 'admin' }); // global
    grantRole({ user_id: 'discord:jack', role: 'admin', agent_group_id: ag.id }); // scoped

    revokeRole({ user_id: 'discord:jack', role: 'admin' }); // revoke global
    expect(isGlobalAdmin('discord:jack')).toBe(false);
    expect(isAdminOfAgentGroup('discord:jack', ag.id)).toBe(true); // scoped still intact
  });
});

describe('listOwners', () => {
  it('returns all owner rows', () => {
    ensureUser({ id: 'telegram:o1', kind: 'telegram' });
    ensureUser({ id: 'telegram:o2', kind: 'telegram' });
    grantRole({ user_id: 'telegram:o1', role: 'owner' });
    grantRole({ user_id: 'telegram:o2', role: 'owner' });

    const owners = listOwners();
    expect(owners).toHaveLength(2);
    const ids = owners.map((r) => r.user_id);
    expect(ids).toContain('telegram:o1');
    expect(ids).toContain('telegram:o2');
  });

  it('returns empty array when no owners exist', () => {
    expect(listOwners()).toEqual([]);
  });
});

describe('listGlobalAdmins', () => {
  it('returns only global admin rows (agent_group_id IS NULL)', () => {
    ensureUser({ id: 'discord:ga1', kind: 'discord' });
    ensureUser({ id: 'discord:sa1', kind: 'discord' });
    const ag = createAgentGroup({ name: 'ScopedG', folder: 'scoped-g' });
    grantRole({ user_id: 'discord:ga1', role: 'admin' }); // global
    grantRole({ user_id: 'discord:sa1', role: 'admin', agent_group_id: ag.id }); // scoped

    const admins = listGlobalAdmins();
    expect(admins).toHaveLength(1);
    expect(admins[0].user_id).toBe('discord:ga1');
    expect(admins[0].agent_group_id).toBeNull();
  });
});

describe('listAdminsOfAgentGroup', () => {
  it('returns only admins scoped to the given agent_group_id', () => {
    ensureUser({ id: 'telegram:scoped1', kind: 'telegram' });
    ensureUser({ id: 'telegram:scoped2', kind: 'telegram' });
    ensureUser({ id: 'telegram:other', kind: 'telegram' });
    const ag1 = createAgentGroup({ name: 'Group A', folder: 'group-a' });
    const ag2 = createAgentGroup({ name: 'Group B', folder: 'group-b' });

    grantRole({ user_id: 'telegram:scoped1', role: 'admin', agent_group_id: ag1.id });
    grantRole({ user_id: 'telegram:scoped2', role: 'admin', agent_group_id: ag1.id });
    grantRole({ user_id: 'telegram:other', role: 'admin', agent_group_id: ag2.id });

    const admins = listAdminsOfAgentGroup(ag1.id);
    expect(admins).toHaveLength(2);
    const ids = admins.map((r) => r.user_id);
    expect(ids).toContain('telegram:scoped1');
    expect(ids).toContain('telegram:scoped2');
    expect(ids).not.toContain('telegram:other');
  });

  it('returns empty array when no admins for the group', () => {
    const ag = createAgentGroup({ name: 'EmptyGroup', folder: 'empty-group' });
    expect(listAdminsOfAgentGroup(ag.id)).toEqual([]);
  });
});

describe('INSERT OR IGNORE idempotency', () => {
  it('granting the same role twice is a no-op (no error, no duplicate)', () => {
    ensureUser({ id: 'telegram:dup', kind: 'telegram' });
    grantRole({ user_id: 'telegram:dup', role: 'owner' });
    // Should not throw
    expect(() => grantRole({ user_id: 'telegram:dup', role: 'owner' })).not.toThrow();
    // Still only one owner row for this user
    const owners = listOwners().filter((r) => r.user_id === 'telegram:dup');
    expect(owners).toHaveLength(1);
  });

  it('granting the same scoped role twice is a no-op', () => {
    ensureUser({ id: 'discord:dup2', kind: 'discord' });
    const ag = createAgentGroup({ name: 'DupGroup', folder: 'dup-group' });
    grantRole({ user_id: 'discord:dup2', role: 'admin', agent_group_id: ag.id });
    expect(() => grantRole({ user_id: 'discord:dup2', role: 'admin', agent_group_id: ag.id })).not.toThrow();

    const admins = listAdminsOfAgentGroup(ag.id);
    expect(admins).toHaveLength(1);
  });
});
