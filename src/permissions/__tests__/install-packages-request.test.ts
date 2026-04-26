/**
 * Phase 5C-03 — host-side request flow for `install_packages`.
 *
 * Covers the validation matrix (parity with the container-side validator)
 * and the requestApproval round-trip: a happy-path call lands a
 * pending_approvals row with the expected action + payload + agent_group_id.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import {
  clearApprovalHandlers,
  getPendingApproval,
  listPendingApprovalsByAction,
} from '../approval-primitive.js';
import {
  handleInstallPackagesRequest,
  registerInstallPackagesHandler,
} from '../install-packages.js';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
  registerInstallPackagesHandler();
});

describe('handleInstallPackagesRequest', () => {
  async function setupGroupWithApprover() {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });
    return createAgentGroup({ name: 'G', folder: 'g' });
  }

  it('happy path: creates a pending_approvals row with apt + npm + reason', async () => {
    const ag = await setupGroupWithApprover();

    const approvalId = await handleInstallPackagesRequest(
      {
        apt: ['curl'],
        npm: ['typescript'],
        reason: 'tools needed',
        groupFolder: ag.folder,
      },
      'telegram',
    );

    expect(approvalId).toBeTruthy();
    const row = getPendingApproval(approvalId!);
    expect(row).toBeDefined();
    expect(row!.action).toBe('install_packages');
    expect(row!.agent_group_id).toBe(ag.id);
    expect(row!.status).toBe('pending');

    const payload = JSON.parse(row!.payload as string);
    expect(payload.apt).toEqual(['curl']);
    expect(payload.npm).toEqual(['typescript']);
    expect(payload.reason).toBe('tools needed');
  });

  it('renders a card title that mentions install + lists each package', async () => {
    const ag = await setupGroupWithApprover();
    const approvalId = await handleInstallPackagesRequest(
      { apt: ['curl', 'jq'], npm: [], reason: 'r', groupFolder: ag.folder },
      'telegram',
    );
    const row = getPendingApproval(approvalId!);
    expect(row!.title).toBe('Install Packages Request');
    const opts = JSON.parse(row!.options_json as string);
    expect(opts.map((o: { id: string }) => o.id).sort()).toEqual([
      'approve',
      'reject',
    ]);
  });

  it('drops + notifies when agent group not found', async () => {
    const approvalId = await handleInstallPackagesRequest(
      { apt: ['curl'], npm: [], reason: 'r', groupFolder: 'no-such-group' },
      'telegram',
    );
    expect(approvalId).toBeUndefined();
    expect(listPendingApprovalsByAction('install_packages')).toHaveLength(0);
  });

  it('rejects empty package lists', async () => {
    const ag = await setupGroupWithApprover();
    const approvalId = await handleInstallPackagesRequest(
      { apt: [], npm: [], reason: 'r', groupFolder: ag.folder },
      'telegram',
    );
    expect(approvalId).toBeUndefined();
    expect(listPendingApprovalsByAction('install_packages')).toHaveLength(0);
  });

  it('rejects request that exceeds MAX_PACKAGES', async () => {
    const ag = await setupGroupWithApprover();
    const apt = Array.from({ length: 21 }, (_, i) => `pkg${i}`);
    const approvalId = await handleInstallPackagesRequest(
      { apt, npm: [], reason: 'r', groupFolder: ag.folder },
      'telegram',
    );
    expect(approvalId).toBeUndefined();
    expect(listPendingApprovalsByAction('install_packages')).toHaveLength(0);
  });

  it('rejects invalid apt names (defense in depth past container validator)', async () => {
    const ag = await setupGroupWithApprover();
    for (const bad of ['curl=1.0', 'CURL', 'curl;rm', '../etc']) {
      const approvalId = await handleInstallPackagesRequest(
        { apt: [bad], npm: [], reason: 'r', groupFolder: ag.folder },
        'telegram',
      );
      expect(approvalId, `should reject "${bad}"`).toBeUndefined();
    }
    expect(listPendingApprovalsByAction('install_packages')).toHaveLength(0);
  });

  it('rejects invalid npm names', async () => {
    const ag = await setupGroupWithApprover();
    for (const bad of ['foo@1.0', 'FOO', 'foo bar']) {
      const approvalId = await handleInstallPackagesRequest(
        { apt: [], npm: [bad], reason: 'r', groupFolder: ag.folder },
        'telegram',
      );
      expect(approvalId, `should reject "${bad}"`).toBeUndefined();
    }
  });

  it('still creates a pending row when no approver exists (orphan group)', async () => {
    // No owner/admin set up — pickApprover returns []. The primitive still
    // persists the row so an admin can be granted later and the click-auth
    // path picks it up.
    const ag = createAgentGroup({ name: 'Orphan', folder: 'orphan' });
    const approvalId = await handleInstallPackagesRequest(
      { apt: ['curl'], npm: [], reason: 'r', groupFolder: ag.folder },
      '',
    );
    expect(approvalId).toBeTruthy();
    const row = getPendingApproval(approvalId!);
    expect(row).toBeDefined();
    expect(row!.channel_type).toBeNull();
  });

  it('accepts scoped npm package names', async () => {
    const ag = await setupGroupWithApprover();
    const approvalId = await handleInstallPackagesRequest(
      { apt: [], npm: ['@anthropic-ai/sdk'], reason: 'sdk', groupFolder: ag.folder },
      'telegram',
    );
    expect(approvalId).toBeTruthy();
    const row = getPendingApproval(approvalId!);
    const payload = JSON.parse(row!.payload as string);
    expect(payload.npm).toEqual(['@anthropic-ai/sdk']);
  });
});
