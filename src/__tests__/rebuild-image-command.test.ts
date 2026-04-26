/**
 * Phase 5B — `/rebuild-image` admin command tests.
 *
 * Mirrors `pause-resume-commands.test.ts`: covers the command-gate match
 * plus the full permission grid (owner / global admin / scoped-admin /
 * non-admin / unauthenticated) and the usage / success / failure replies
 * from the dispatcher helper.
 *
 * `buildAgentGroupImage` is a static-mocked module so we can drive both
 * the success and failure paths without touching Docker.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  buildAgentGroupImage: vi.fn(),
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
import { createAgentGroup } from '../db/agent-groups.js';
import { ensureUser } from '../permissions/users.js';
import { grantRole } from '../permissions/user-roles.js';
import { isAdminCommand } from '../command-gate.js';
import { buildAgentGroupImage } from '../container-runner.js';
import { tryHandleRebuildImageAdminCommand } from '../rebuild-image-admin-command.js';

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
});

describe('command-gate: /rebuild-image is an admin command', () => {
  it('isAdminCommand recognises /rebuild-image', () => {
    expect(isAdminCommand('/rebuild-image')).toBe(true);
  });

  it('isAdminCommand recognises /rebuild-image with target id', () => {
    expect(isAdminCommand('/rebuild-image ag-123')).toBe(true);
  });

  it('isAdminCommand does NOT match /rebuild-images (plural)', () => {
    expect(isAdminCommand('/rebuild-images')).toBe(false);
  });
});

describe('tryHandleRebuildImageAdminCommand', () => {
  it('returns { handled: false } for non-rebuild-image commands', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    const result = await tryHandleRebuildImageAdminCommand({
      command: '/grant',
      args: [],
      userId: 'telegram:owner',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(false);
  });

  it('denies /rebuild-image when user is not threaded (unauthenticated)', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    const result = await tryHandleRebuildImageAdminCommand({
      command: '/rebuild-image',
      args: [ag.id],
      userId: undefined,
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('admin-only');
    expect(vi.mocked(buildAgentGroupImage)).not.toHaveBeenCalled();
  });

  it('denies /rebuild-image for a non-admin user', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:rando', kind: 'telegram' });
    const result = await tryHandleRebuildImageAdminCommand({
      command: '/rebuild-image',
      args: [ag.id],
      userId: 'telegram:rando',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('admin-only');
    expect(vi.mocked(buildAgentGroupImage)).not.toHaveBeenCalled();
  });

  it('admin without target arg gets usage reply', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const result = await tryHandleRebuildImageAdminCommand({
      command: '/rebuild-image',
      args: [],
      userId: 'telegram:owner',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Usage:');
    expect(vi.mocked(buildAgentGroupImage)).not.toHaveBeenCalled();
  });

  it('owner with target id triggers buildAgentGroupImage and reports the new tag', async () => {
    vi.mocked(buildAgentGroupImage).mockResolvedValueOnce('nanoclaw-test-agent:ag-123');

    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const result = await tryHandleRebuildImageAdminCommand({
      command: '/rebuild-image',
      args: [ag.id],
      userId: 'telegram:owner',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Image rebuilt');
    expect(result.reply).toContain('nanoclaw-test-agent:ag-123');
    expect(result.imageTag).toBe('nanoclaw-test-agent:ag-123');
    expect(vi.mocked(buildAgentGroupImage)).toHaveBeenCalledWith(ag.id);
  });

  it('global admin can rebuild a different group than the issuing one', async () => {
    vi.mocked(buildAgentGroupImage).mockResolvedValueOnce('nanoclaw-test-agent:ag-other');

    const ag1 = createAgentGroup({ name: 'A', folder: 'a' });
    const ag2 = createAgentGroup({ name: 'B', folder: 'b' });
    ensureUser({ id: 'telegram:gadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:gadmin', role: 'admin' });

    const result = await tryHandleRebuildImageAdminCommand({
      command: '/rebuild-image',
      args: [ag2.id],
      userId: 'telegram:gadmin',
      agentGroupId: ag1.id,
    });
    expect(result.handled).toBe(true);
    expect(result.permissionReason).toBe('global-admin');
    expect(result.imageTag).toBe('nanoclaw-test-agent:ag-other');
  });

  it('scoped admin of THIS group can rebuild', async () => {
    vi.mocked(buildAgentGroupImage).mockResolvedValueOnce('nanoclaw-test-agent:ag-scoped');

    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag.id });

    const result = await tryHandleRebuildImageAdminCommand({
      command: '/rebuild-image',
      args: [ag.id],
      userId: 'telegram:scoped',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.permissionReason).toBe('scoped-admin');
    expect(result.imageTag).toBe('nanoclaw-test-agent:ag-scoped');
  });

  it('scoped admin of a DIFFERENT group is denied', async () => {
    const ag1 = createAgentGroup({ name: 'A', folder: 'a' });
    const ag2 = createAgentGroup({ name: 'B', folder: 'b' });
    ensureUser({ id: 'telegram:other', kind: 'telegram' });
    grantRole({ user_id: 'telegram:other', role: 'admin', agent_group_id: ag2.id });

    const result = await tryHandleRebuildImageAdminCommand({
      command: '/rebuild-image',
      args: [ag1.id],
      userId: 'telegram:other',
      agentGroupId: ag1.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('admin-only');
    expect(vi.mocked(buildAgentGroupImage)).not.toHaveBeenCalled();
  });

  it('build failure surfaces the error message in the reply', async () => {
    vi.mocked(buildAgentGroupImage).mockRejectedValueOnce(new Error('Nothing to build.'));

    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const result = await tryHandleRebuildImageAdminCommand({
      command: '/rebuild-image',
      args: [ag.id],
      userId: 'telegram:owner',
      agentGroupId: ag.id,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toContain('Rebuild failed');
    expect(result.reply).toContain('Nothing to build');
    expect(result.imageTag).toBeUndefined();
  });
});
