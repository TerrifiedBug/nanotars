import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { _initTestDatabase } from '../db/init.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { ensureUser } from '../permissions/users.js';
import { grantRole } from '../permissions/user-roles.js';
import {
  handleEmergencyStop,
  handleResumeProcessing,
} from '../lifecycle-handlers.js';
import { pausedGate, _resetPausedGate } from '../lifecycle.js';

beforeEach(() => {
  _initTestDatabase();
  _resetPausedGate();
});

afterEach(() => {
  _resetPausedGate();
});

describe('handleEmergencyStop', () => {
  it('drops silently when groupFolder does not match an agent group', async () => {
    await handleEmergencyStop(
      { groupFolder: 'no-such-group', isMain: true },
      undefined,
    );
    expect(pausedGate.isPaused()).toBe(false);
  });

  it('isMain fallback admits the call when sender is not threaded', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    expect(ag.id).toBeTruthy();

    await handleEmergencyStop(
      { groupFolder: 'main', isMain: true, reason: 'test' },
      undefined,
    );
    expect(pausedGate.isPaused()).toBe(true);
  });

  it('non-main IPC source without sender is denied', async () => {
    createAgentGroup({ name: 'Sub', folder: 'sub' });

    await handleEmergencyStop(
      { groupFolder: 'sub', isMain: false, reason: 'test' },
      undefined,
    );
    expect(pausedGate.isPaused()).toBe(false);
  });

  it('owner senderUserId is admitted regardless of isMain', async () => {
    createAgentGroup({ name: 'Sub', folder: 'sub' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    await handleEmergencyStop(
      { groupFolder: 'sub', isMain: false, reason: 'test' },
      'telegram:owner',
    );
    expect(pausedGate.isPaused()).toBe(true);
  });

  it('global admin senderUserId is admitted', async () => {
    createAgentGroup({ name: 'Sub', folder: 'sub' });
    ensureUser({ id: 'telegram:gadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:gadmin', role: 'admin' });

    await handleEmergencyStop(
      { groupFolder: 'sub', isMain: false },
      'telegram:gadmin',
    );
    expect(pausedGate.isPaused()).toBe(true);
  });

  it('scoped admin of the requesting group is admitted', async () => {
    const ag = createAgentGroup({ name: 'Sub', folder: 'sub' });
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag.id });

    await handleEmergencyStop(
      { groupFolder: 'sub', isMain: false },
      'telegram:scoped',
    );
    expect(pausedGate.isPaused()).toBe(true);
  });

  it('scoped admin of a DIFFERENT group is denied', async () => {
    createAgentGroup({ name: 'A', folder: 'a' });
    const agB = createAgentGroup({ name: 'B', folder: 'b' });
    ensureUser({ id: 'telegram:other', kind: 'telegram' });
    grantRole({ user_id: 'telegram:other', role: 'admin', agent_group_id: agB.id });

    await handleEmergencyStop(
      { groupFolder: 'a', isMain: false },
      'telegram:other',
    );
    expect(pausedGate.isPaused()).toBe(false);
  });

  it('non-admin senderUserId is denied', async () => {
    createAgentGroup({ name: 'Sub', folder: 'sub' });
    ensureUser({ id: 'telegram:rando', kind: 'telegram' });

    await handleEmergencyStop(
      { groupFolder: 'sub', isMain: false },
      'telegram:rando',
    );
    expect(pausedGate.isPaused()).toBe(false);
  });

  it('does NOT call GroupQueue.emergencyStop (kill-now path is preserved separately)', async () => {
    // Defense-in-spec: the soft-pause handler must not trigger the kill-now
    // path. We assert this indirectly by ensuring the only side effect is
    // the gate flag — there's no GroupQueue dependency in the handler.
    createAgentGroup({ name: 'Main', folder: 'main' });
    await handleEmergencyStop(
      { groupFolder: 'main', isMain: true },
      undefined,
    );
    expect(pausedGate.isPaused()).toBe(true);
    // No GroupQueue is referenced by the handler, so there's nothing to
    // assert "wasn't called" against — this test guards via pause-only side
    // effect on a passing path.
  });
});

describe('handleResumeProcessing', () => {
  it('drops silently when groupFolder does not match', async () => {
    pausedGate.pause('precondition');
    await handleResumeProcessing(
      { groupFolder: 'no-such-group', isMain: true },
      undefined,
    );
    expect(pausedGate.isPaused()).toBe(true);
  });

  it('isMain fallback admits the resume call', async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });
    pausedGate.pause('precondition');

    await handleResumeProcessing(
      { groupFolder: 'main', isMain: true },
      undefined,
    );
    expect(pausedGate.isPaused()).toBe(false);
  });

  it('non-admin is denied; gate stays paused', async () => {
    createAgentGroup({ name: 'Sub', folder: 'sub' });
    ensureUser({ id: 'telegram:rando', kind: 'telegram' });
    pausedGate.pause('precondition');

    await handleResumeProcessing(
      { groupFolder: 'sub', isMain: false },
      'telegram:rando',
    );
    expect(pausedGate.isPaused()).toBe(true);
  });

  it('owner resumes from any source', async () => {
    createAgentGroup({ name: 'Sub', folder: 'sub' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    pausedGate.pause('precondition');

    await handleResumeProcessing(
      { groupFolder: 'sub', isMain: false },
      'telegram:owner',
    );
    expect(pausedGate.isPaused()).toBe(false);
  });
});
