import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { addMember } from '../agent-group-members.js';
import { canAccessAgentGroup } from '../access.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('canAccessAgentGroup', () => {
  it('unauthenticated (userId undefined) → denied with reason "unauthenticated"', () => {
    const ag = createAgentGroup({ name: 'Alpha', folder: 'alpha' });
    const result = canAccessAgentGroup(undefined, ag.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unauthenticated');
  });

  it('owner → allowed with reason "owner"', () => {
    const ag = createAgentGroup({ name: 'Beta', folder: 'beta' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const result = canAccessAgentGroup('telegram:owner', ag.id);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('owner');
  });

  it('global admin → allowed with reason "global-admin"', () => {
    const ag = createAgentGroup({ name: 'Gamma', folder: 'gamma' });
    ensureUser({ id: 'telegram:gadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:gadmin', role: 'admin' }); // no agent_group_id → global

    const result = canAccessAgentGroup('telegram:gadmin', ag.id);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('global-admin');
  });

  it('scoped admin (admin @ this agent_group) → allowed with reason "scoped-admin"', () => {
    const ag = createAgentGroup({ name: 'Delta', folder: 'delta' });
    ensureUser({ id: 'telegram:sadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:sadmin', role: 'admin', agent_group_id: ag.id });

    const result = canAccessAgentGroup('telegram:sadmin', ag.id);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('scoped-admin');
  });

  it('member (agent_group_members row only, no role) → allowed with reason "member"', () => {
    const ag = createAgentGroup({ name: 'Epsilon', folder: 'epsilon' });
    ensureUser({ id: 'telegram:member1', kind: 'telegram' });
    addMember({ user_id: 'telegram:member1', agent_group_id: ag.id });

    const result = canAccessAgentGroup('telegram:member1', ag.id);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('member');
  });

  it('unknown user (no role, not a member) → denied with reason "not-a-member"', () => {
    const ag = createAgentGroup({ name: 'Zeta', folder: 'zeta' });
    ensureUser({ id: 'telegram:stranger', kind: 'telegram' });
    // No role granted, no member row added.

    const result = canAccessAgentGroup('telegram:stranger', ag.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not-a-member');
  });

  it('scoped admin of OTHER agent_group → denied with reason "not-a-member"', () => {
    const agA = createAgentGroup({ name: 'GroupA', folder: 'group-a' });
    const agB = createAgentGroup({ name: 'GroupB', folder: 'group-b' });
    ensureUser({ id: 'telegram:scopedadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:scopedadmin', role: 'admin', agent_group_id: agA.id });

    // Has scoped admin on agA, but should be denied for agB.
    const resultA = canAccessAgentGroup('telegram:scopedadmin', agA.id);
    expect(resultA.allowed).toBe(true);
    expect(resultA.reason).toBe('scoped-admin');

    const resultB = canAccessAgentGroup('telegram:scopedadmin', agB.id);
    expect(resultB.allowed).toBe(false);
    expect(resultB.reason).toBe('not-a-member');
  });
});
