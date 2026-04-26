/**
 * Phase 5B — buildContainerArgs imageTag selection.
 *
 * After 5B-04, the spawn path prefers `group.container_config.imageTag` (set
 * by `buildAgentGroupImage`) over the shared `CONTAINER_IMAGE` base. Falls
 * back to `CONTAINER_IMAGE` when the JSON is missing, malformed, or has no
 * imageTag.
 *
 * Mirrors the OneCLI/admin-env tests: drive `buildContainerArgsForTesting`
 * directly, assert on the produced argv. The image tag is always the LAST
 * element of the argv (docker run ... <image>).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase } from '../db/init.js';
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

function lastArg(args: string[]): string {
  return args[args.length - 1];
}

describe('Phase 5B: buildContainerArgs uses container_config.imageTag with fallback', () => {
  it('falls back to CONTAINER_IMAGE when group is undefined', async () => {
    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting([], 'nc-test', undefined);
    expect(lastArg(args)).toBe('nanoclaw-agent:latest');
  });

  it('falls back to CONTAINER_IMAGE when container_config is null', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting(
      [],
      'nc-test',
      ag.folder,
      ag,
      undefined,
    );
    expect(lastArg(args)).toBe('nanoclaw-agent:latest');
  });

  it('falls back to CONTAINER_IMAGE when container_config has no imageTag', async () => {
    const ag = createAgentGroup({
      name: 'Main',
      folder: 'main',
      container_config: JSON.stringify({ packages: { apt: ['curl'], npm: [] } }),
    });
    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting(
      [],
      'nc-test',
      ag.folder,
      ag,
      undefined,
    );
    expect(lastArg(args)).toBe('nanoclaw-agent:latest');
  });

  it('uses imageTag when present in container_config', async () => {
    const ag = createAgentGroup({
      name: 'Main',
      folder: 'main',
      container_config: JSON.stringify({
        packages: { apt: ['curl'], npm: [] },
        imageTag: 'nanoclaw-test-agent:ag-xyz',
      }),
    });
    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting(
      [],
      'nc-test',
      ag.folder,
      ag,
      undefined,
    );
    expect(lastArg(args)).toBe('nanoclaw-test-agent:ag-xyz');
  });

  it('falls back to CONTAINER_IMAGE when container_config is malformed JSON', async () => {
    // Synthesize a group with a deliberately broken container_config — the
    // shape extension says "old-shape rows still parse"; malformed strings
    // must not crash the spawn path either.
    const ag: AgentGroup = {
      id: 'broken',
      name: 'Broken',
      folder: 'broken',
      agent_provider: null,
      container_config: '{not-json',
      created_at: new Date().toISOString(),
    };
    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting(
      [],
      'nc-test',
      ag.folder,
      ag,
      undefined,
    );
    expect(lastArg(args)).toBe('nanoclaw-agent:latest');
  });
});
