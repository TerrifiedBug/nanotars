/**
 * Phase 5E — smoke tests for the NANOCLAW_IS_ADMIN env var injection.
 *
 * Mirrors `Phase 5A` shape from container-runner.test.ts: drive
 * `buildContainerArgsForTesting` (the test-only export of
 * `buildContainerArgs`) and assert the produced docker `run` arg list
 * contains the expected `-e NANOCLAW_IS_ADMIN=...` pair for each role
 * combination.
 *
 * The full role check goes through `permissions/user-roles.ts` which talks
 * to the real DB, so we wire in `_initTestDatabase` per case to flip
 * roles. OneCLI + logger are mocked exactly as in the upstream file so
 * the test runs offline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase } from '../db/init.js';
import { ensureUser } from '../permissions/users.js';
import { grantRole } from '../permissions/user-roles.js';
import { createAgentGroup } from '../db/agent-groups.js';
import type { AgentGroup } from '../types.js';

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = vi.fn().mockResolvedValue(undefined);
    applyContainerConfig = vi.fn().mockResolvedValue(false);
    configureManualApproval = vi.fn();
  },
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    INSTALL_SLUG: 'nanoclaw-test',
    ONECLI_URL: 'http://127.0.0.1:10254',
    ONECLI_API_KEY: '',
  };
});

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
});

function findEnvArg(args: string[], key: string): string | undefined {
  // docker run uses `-e KEY=VALUE`. Find the `-e` immediately followed by
  // a value starting with `KEY=` and return the value half.
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e' && args[i + 1].startsWith(`${key}=`)) {
      return args[i + 1].slice(key.length + 1);
    }
  }
  return undefined;
}

describe('Phase 5E: NANOCLAW_IS_ADMIN env injection', () => {
  it('defaults to "0" when senderUserId is undefined (scheduled task path)', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting(
      [],
      'nc-test',
      ag.folder,
      ag,
      undefined,
    );
    expect(findEnvArg(args, 'NANOCLAW_IS_ADMIN')).toBe('0');
  });

  it('defaults to "0" when group is undefined (legacy/no-group spawn)', async () => {
    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting([], 'nc-test', undefined);
    expect(findEnvArg(args, 'NANOCLAW_IS_ADMIN')).toBe('0');
  });

  it('non-admin sender → "0"', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:rando', kind: 'telegram' });

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting(
      [],
      'nc-test',
      ag.folder,
      ag,
      'telegram:rando',
    );
    expect(findEnvArg(args, 'NANOCLAW_IS_ADMIN')).toBe('0');
  });

  it('owner sender → "1"', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting(
      [],
      'nc-test',
      ag.folder,
      ag,
      'telegram:owner',
    );
    expect(findEnvArg(args, 'NANOCLAW_IS_ADMIN')).toBe('1');
  });

  it('global admin sender → "1"', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:gadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:gadmin', role: 'admin' });

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting(
      [],
      'nc-test',
      ag.folder,
      ag,
      'telegram:gadmin',
    );
    expect(findEnvArg(args, 'NANOCLAW_IS_ADMIN')).toBe('1');
  });

  it('scoped admin of THIS agent group → "1"', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    grantRole({
      user_id: 'telegram:scoped',
      role: 'admin',
      agent_group_id: ag.id,
    });

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting(
      [],
      'nc-test',
      ag.folder,
      ag,
      'telegram:scoped',
    );
    expect(findEnvArg(args, 'NANOCLAW_IS_ADMIN')).toBe('1');
  });

  it('scoped admin of a DIFFERENT agent group → "0"', async () => {
    const targetGroup = createAgentGroup({ name: 'Target', folder: 'target' });
    const otherGroup: AgentGroup = createAgentGroup({ name: 'Other', folder: 'other' });
    ensureUser({ id: 'telegram:scoped-elsewhere', kind: 'telegram' });
    grantRole({
      user_id: 'telegram:scoped-elsewhere',
      role: 'admin',
      agent_group_id: otherGroup.id,
    });

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting(
      [],
      'nc-test',
      targetGroup.folder,
      targetGroup,
      'telegram:scoped-elsewhere',
    );
    expect(findEnvArg(args, 'NANOCLAW_IS_ADMIN')).toBe('0');
  });

  it('the env arg is always present (never omitted)', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting([], 'nc-test', ag.folder, ag);
    // The env var should always be set so non-admin containers are
    // explicit, not relying on absence.
    expect(args.some((a) => a.startsWith('NANOCLAW_IS_ADMIN='))).toBe(true);
  });
});
