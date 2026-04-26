/**
 * Phase 5B — buildAgentGroupImage IO tests.
 *
 * `buildAgentGroupImage` is the IO twin of `generateAgentGroupDockerfile`.
 * The pure generator already has its own coverage in image-build.test.ts; here
 * we drive the IO surface end-to-end against the test DB while mocking
 * `child_process.execSync` so the test runs offline (no Docker required).
 *
 * Two cases:
 *  1. The "nothing to build" guard rejects empty configs.
 *  2. After a successful build, container_config.imageTag is persisted so the
 *     next `buildContainerArgs` will spawn from the per-group tag.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: vi.fn(() => Buffer.from('')),
  };
});

vi.mock('../container-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../container-runtime.js')>(
    '../container-runtime.js',
  );
  return {
    ...actual,
    cli: vi.fn(() => 'docker'),
    extraRunArgs: vi.fn(() => []),
    fixMountPermissions: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = vi.fn().mockResolvedValue(undefined);
    applyContainerConfig = vi.fn().mockResolvedValue(false);
    configureManualApproval = vi.fn();
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { _initTestDatabase } from '../db/init.js';
import { createAgentGroup, getAgentGroupById } from '../db/agent-groups.js';

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
});

describe('buildAgentGroupImage', () => {
  it('throws when nothing to build (no apt, no npm, no partials)', async () => {
    const ag = createAgentGroup({ name: 'x', folder: 'x', container_config: '{}' });
    const { buildAgentGroupImage } = await import('../container-runner.js');
    await expect(buildAgentGroupImage(ag.id)).rejects.toThrow(/Nothing to build/);
  });

  it('throws when agent group is missing', async () => {
    const { buildAgentGroupImage } = await import('../container-runner.js');
    await expect(buildAgentGroupImage('does-not-exist')).rejects.toThrow(/not found/);
  });

  it('updates container_config.imageTag after a successful build', async () => {
    const ag = createAgentGroup({
      name: 'x',
      folder: 'x',
      container_config: JSON.stringify({ packages: { apt: ['curl'], npm: [] } }),
    });
    const { buildAgentGroupImage } = await import('../container-runner.js');
    const tag = await buildAgentGroupImage(ag.id);
    expect(tag).toContain(`:${ag.id}`);

    const updated = getAgentGroupById(ag.id);
    expect(updated).toBeDefined();
    const cfg = JSON.parse(updated!.container_config!);
    expect(cfg.imageTag).toBe(tag);
    // Round-trip: previously-stored fields must survive the partial update.
    expect(cfg.packages.apt).toEqual(['curl']);
  });

  it('invokes docker build with the expected tag and label', async () => {
    const cp = await import('child_process');
    const ag = createAgentGroup({
      name: 'x',
      folder: 'x',
      container_config: JSON.stringify({ packages: { apt: [], npm: ['typescript'] } }),
    });
    const { buildAgentGroupImage } = await import('../container-runner.js');
    const tag = await buildAgentGroupImage(ag.id);

    const mockExecSync = vi.mocked(cp.execSync);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const cmd = String(mockExecSync.mock.calls[0][0]);
    expect(cmd).toContain(`docker build`);
    expect(cmd).toContain(`-t ${tag}`);
    expect(cmd).toContain(`--label nanoclaw.agent_group=${ag.id}`);
  });
});
