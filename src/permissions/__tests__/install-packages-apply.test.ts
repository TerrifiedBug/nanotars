/**
 * Phase 5C-04 — applyDecision for install_packages.
 *
 * Drives the apply-half of the approval handler with mocked deps:
 *   - approve  → container_config.packages mutated (apt + npm appended,
 *     deduped); buildImage called; restartGroup called; notifyAfter scheduled.
 *   - reject / expired → no mutation; notifyAgent called with denial text.
 *   - approve with build failure → notifyAgent called with the failure text;
 *     packages still mutated (so /rebuild-image can retry).
 *   - approve with no deps wired → no mutation, log + return (render-only mode).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import {
  createAgentGroup,
  getAgentGroupById,
} from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import {
  clearApprovalHandlers,
  getApprovalHandler,
  getPendingApproval,
} from '../approval-primitive.js';
import {
  handleInstallPackagesRequest,
  registerInstallPackagesHandler,
} from '../install-packages.js';
import type { ContainerConfig } from '../../types.js';

interface DepsHarness {
  buildImage: ReturnType<typeof vi.fn>;
  restartGroup: ReturnType<typeof vi.fn>;
  notifyAfter: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: Partial<DepsHarness> = {}): DepsHarness {
  return {
    buildImage: vi.fn(async () => 'nanoclaw-agent:test'),
    restartGroup: vi.fn(async () => undefined),
    notifyAfter: vi.fn(),
    ...overrides,
  };
}

function readContainerConfig(agentGroupId: string): ContainerConfig {
  const ag = getAgentGroupById(agentGroupId);
  if (!ag) throw new Error('agent group missing');
  return ag.container_config
    ? (JSON.parse(ag.container_config) as ContainerConfig)
    : {};
}

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
});

describe('install_packages applyDecision', () => {
  async function setupApprovalRow(deps: DepsHarness) {
    registerInstallPackagesHandler(deps);
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const approvalId = await handleInstallPackagesRequest(
      { apt: ['curl'], npm: ['typescript'], reason: 'r', groupFolder: ag.folder },
      'telegram',
    );
    expect(approvalId).toBeTruthy();
    return { ag, approvalId: approvalId! };
  }

  it('approve: mutates container_config.packages, calls buildImage + restartGroup + notifyAfter', async () => {
    const deps = makeDeps();
    const { ag, approvalId } = await setupApprovalRow(deps);
    const handler = getApprovalHandler('install_packages')!;
    const row = getPendingApproval(approvalId)!;
    await handler.applyDecision!({
      approvalId,
      payload: JSON.parse(row.payload as string),
      decision: 'approved',
    });

    const cfg = readContainerConfig(ag.id);
    expect(cfg.packages).toEqual({ apt: ['curl'], npm: ['typescript'] });
    expect(deps.buildImage).toHaveBeenCalledWith(ag.id);
    expect(deps.restartGroup).toHaveBeenCalledWith(
      ag.folder,
      expect.stringMatching(/install_packages/),
    );
    expect(deps.notifyAfter).toHaveBeenCalledTimes(1);
    const [groupId, text, deferMs] = deps.notifyAfter.mock.calls[0];
    expect(groupId).toBe(ag.id);
    expect(text).toMatch(/Packages installed/);
    expect(text).toMatch(/apt:curl/);
    expect(text).toMatch(/npm:typescript/);
    expect(deferMs).toBe(5000);
  });

  it('approve: appends + dedupes packages on repeated approvals', async () => {
    const deps = makeDeps();
    const { ag } = await setupApprovalRow(deps);

    // First approval: curl + typescript (already done by setupApprovalRow).
    const handler = getApprovalHandler('install_packages')!;
    const a1 = await handleInstallPackagesRequest(
      { apt: ['curl'], npm: ['typescript'], reason: 'r', groupFolder: ag.folder },
      '',
    );
    const r1 = getPendingApproval(a1!)!;
    await handler.applyDecision!({
      approvalId: a1!,
      payload: JSON.parse(r1.payload as string),
      decision: 'approved',
    });

    // Second approval adds jq and a duplicate curl — should dedupe.
    const a2 = await handleInstallPackagesRequest(
      { apt: ['jq', 'curl'], npm: [], reason: 'r', groupFolder: ag.folder },
      '',
    );
    const r2 = getPendingApproval(a2!)!;
    await handler.applyDecision!({
      approvalId: a2!,
      payload: JSON.parse(r2.payload as string),
      decision: 'approved',
    });

    const cfg = readContainerConfig(ag.id);
    expect(cfg.packages!.apt.sort()).toEqual(['curl', 'jq']);
    expect(cfg.packages!.npm).toEqual(['typescript']);
  });

  it('reject: does not mutate config, notifies the agent of denial', async () => {
    const deps = makeDeps();
    const { ag, approvalId } = await setupApprovalRow(deps);
    const handler = getApprovalHandler('install_packages')!;
    const row = getPendingApproval(approvalId)!;
    await handler.applyDecision!({
      approvalId,
      payload: JSON.parse(row.payload as string),
      decision: 'rejected',
    });

    const cfg = readContainerConfig(ag.id);
    expect(cfg.packages).toBeUndefined();
    expect(deps.buildImage).not.toHaveBeenCalled();
    expect(deps.restartGroup).not.toHaveBeenCalled();
  });

  it('expired: same as reject (no mutation)', async () => {
    const deps = makeDeps();
    const { ag, approvalId } = await setupApprovalRow(deps);
    const handler = getApprovalHandler('install_packages')!;
    const row = getPendingApproval(approvalId)!;
    await handler.applyDecision!({
      approvalId,
      payload: JSON.parse(row.payload as string),
      decision: 'expired',
    });

    const cfg = readContainerConfig(ag.id);
    expect(cfg.packages).toBeUndefined();
    expect(deps.buildImage).not.toHaveBeenCalled();
  });

  it('build failure: config still mutated, error surfaced via notifyAgent', async () => {
    const deps = makeDeps({
      buildImage: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { ag, approvalId } = await setupApprovalRow(deps);
    const handler = getApprovalHandler('install_packages')!;
    const row = getPendingApproval(approvalId)!;
    await handler.applyDecision!({
      approvalId,
      payload: JSON.parse(row.payload as string),
      decision: 'approved',
    });

    // Mutation happens BEFORE buildImage so the operator can /rebuild-image.
    const cfg = readContainerConfig(ag.id);
    expect(cfg.packages).toEqual({ apt: ['curl'], npm: ['typescript'] });
    expect(deps.buildImage).toHaveBeenCalled();
    expect(deps.restartGroup).not.toHaveBeenCalled();
    expect(deps.notifyAfter).not.toHaveBeenCalled();
  });

  it('no deps wired: approve is a no-op (render-only registration mode)', async () => {
    registerInstallPackagesHandler(); // no deps
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
    const ag = createAgentGroup({ name: 'G', folder: 'g' });
    const approvalId = await handleInstallPackagesRequest(
      { apt: ['curl'], npm: [], reason: 'r', groupFolder: ag.folder },
      '',
    );
    const handler = getApprovalHandler('install_packages')!;
    const row = getPendingApproval(approvalId!)!;
    await handler.applyDecision!({
      approvalId: approvalId!,
      payload: JSON.parse(row.payload as string),
      decision: 'approved',
    });

    const cfg = readContainerConfig(ag.id);
    expect(cfg.packages).toBeUndefined();
  });
});
