import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { isMember, addMember, removeMember, listMembers } from '../agent-group-members.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('addMember + isMember', () => {
  it('explicit member round-trip: addMember then isMember returns true', () => {
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    ensureUser({ id: 'telegram:alice', kind: 'telegram' });

    addMember({ user_id: 'telegram:alice', agent_group_id: ag.id });

    expect(isMember('telegram:alice', ag.id)).toBe(true);
  });

  it('isMember returns false for a user with no row and no elevated role', () => {
    const ag = createAgentGroup({ name: 'Beta', folder: 'beta' });
    ensureUser({ id: 'telegram:nobody', kind: 'telegram' });

    expect(isMember('telegram:nobody', ag.id)).toBe(false);
  });
});

describe('implicit membership for elevated roles', () => {
  it('isMember returns true for an owner without an explicit agent_group_members row', () => {
    const ag = createAgentGroup({ name: 'Gamma', folder: 'gamma' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    // No addMember call — owner is an implicit member.
    expect(isMember('telegram:owner', ag.id)).toBe(true);
  });

  it('isMember returns true for a global admin without an explicit row', () => {
    const ag = createAgentGroup({ name: 'Delta', folder: 'delta' });
    ensureUser({ id: 'telegram:gadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:gadmin', role: 'admin' }); // global (no agent_group_id)

    expect(isMember('telegram:gadmin', ag.id)).toBe(true);
  });

  it('isMember returns true for a scoped admin of the same agent group without an explicit row', () => {
    const ag = createAgentGroup({ name: 'Epsilon', folder: 'epsilon' });
    ensureUser({ id: 'telegram:sadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:sadmin', role: 'admin', agent_group_id: ag.id });

    expect(isMember('telegram:sadmin', ag.id)).toBe(true);
  });

  it('scoped admin of agent group A is NOT an implicit member of agent group B', () => {
    const agA = createAgentGroup({ name: 'GroupA', folder: 'group-a' });
    const agB = createAgentGroup({ name: 'GroupB', folder: 'group-b' });
    ensureUser({ id: 'telegram:scopedadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:scopedadmin', role: 'admin', agent_group_id: agA.id });

    expect(isMember('telegram:scopedadmin', agA.id)).toBe(true);
    expect(isMember('telegram:scopedadmin', agB.id)).toBe(false);
  });
});

describe('removeMember', () => {
  it('removes the explicit row; non-admin no longer a member', () => {
    const ag = createAgentGroup({ name: 'Zeta', folder: 'zeta' });
    ensureUser({ id: 'telegram:user1', kind: 'telegram' });

    addMember({ user_id: 'telegram:user1', agent_group_id: ag.id });
    expect(isMember('telegram:user1', ag.id)).toBe(true);

    removeMember({ user_id: 'telegram:user1', agent_group_id: ag.id });
    expect(isMember('telegram:user1', ag.id)).toBe(false);
  });

  it('removing explicit row of a global-admin still leaves them as implicit member', () => {
    const ag = createAgentGroup({ name: 'Eta', folder: 'eta' });
    ensureUser({ id: 'telegram:gadmin2', kind: 'telegram' });
    grantRole({ user_id: 'telegram:gadmin2', role: 'admin' });

    // Add an explicit row too, then remove it.
    addMember({ user_id: 'telegram:gadmin2', agent_group_id: ag.id });
    removeMember({ user_id: 'telegram:gadmin2', agent_group_id: ag.id });

    // Admin remains an implicit member even without the explicit row.
    expect(isMember('telegram:gadmin2', ag.id)).toBe(true);
  });
});

describe('listMembers', () => {
  it('returns only explicit members (not admins via implicit membership)', () => {
    const ag = createAgentGroup({ name: 'Theta', folder: 'theta' });
    ensureUser({ id: 'telegram:explicit1', kind: 'telegram' });
    ensureUser({ id: 'telegram:explicit2', kind: 'telegram' });
    ensureUser({ id: 'telegram:admin1', kind: 'telegram' });

    // admin1 gets implicit membership via role but no agent_group_members row.
    grantRole({ user_id: 'telegram:admin1', role: 'admin', agent_group_id: ag.id });

    addMember({ user_id: 'telegram:explicit1', agent_group_id: ag.id });
    addMember({ user_id: 'telegram:explicit2', agent_group_id: ag.id });

    const members = listMembers(ag.id);
    // Only the two explicit rows should appear.
    expect(members).toHaveLength(2);
    const ids = members.map((u) => u.id);
    expect(ids).toContain('telegram:explicit1');
    expect(ids).toContain('telegram:explicit2');
    expect(ids).not.toContain('telegram:admin1');
  });

  it('returns empty array when no explicit members exist', () => {
    const ag = createAgentGroup({ name: 'Iota', folder: 'iota' });
    expect(listMembers(ag.id)).toEqual([]);
  });
});

describe('INSERT OR IGNORE deduplication', () => {
  it('addMember twice does not error and does not create duplicate rows', () => {
    const ag = createAgentGroup({ name: 'Kappa', folder: 'kappa' });
    ensureUser({ id: 'telegram:dup', kind: 'telegram' });

    addMember({ user_id: 'telegram:dup', agent_group_id: ag.id });
    // Second call should be a no-op (INSERT OR IGNORE).
    expect(() => addMember({ user_id: 'telegram:dup', agent_group_id: ag.id })).not.toThrow();

    const members = listMembers(ag.id);
    expect(members).toHaveLength(1);
  });
});
