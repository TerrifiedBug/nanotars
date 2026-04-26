/**
 * Phase 4C C6 — OneCLI manual-approval bridge tests.
 *
 * The SDK is mocked so the test process never opens a real long-poll. Each
 * test seeds users + roles + DMs as needed and exercises `handleRequest`
 * directly (the path the SDK callback would invoke), or drives the
 * registered ApprovalHandler.applyDecision callback to simulate a click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureUser } from '../users.js';
import { grantRole } from '../user-roles.js';
import { ensureUserDm } from '../user-dms.js';
import {
  clearApprovalHandlers,
  getApprovalHandler,
  getPendingApproval,
} from '../approval-primitive.js';

// Capture the callback OneCLI.configureManualApproval would receive in
// production, plus stop()/instance state, so tests can drive it directly.
const sdkState = {
  capturedCallback: null as
    | null
    | ((req: unknown) => Promise<'approve' | 'deny'>),
  stopCalls: 0,
  ctorCalls: 0,
};

vi.mock('@onecli-sh/sdk', () => {
  class OneCLI {
    constructor(_opts: unknown) {
      sdkState.ctorCalls++;
    }
    configureManualApproval(cb: (req: unknown) => Promise<'approve' | 'deny'>) {
      sdkState.capturedCallback = cb;
      return {
        stop: () => {
          sdkState.stopCalls++;
        },
      };
    }
  }
  return { OneCLI };
});

import {
  ONECLI_ACTION,
  _getPendingForTest,
  handleRequest,
  startOneCLIBridge,
  stopOneCLIBridge,
} from '../onecli-bridge.js';
import type { ApprovalRequest } from '@onecli-sh/sdk';

function buildRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'onecli-req-001',
    method: 'POST',
    url: 'https://api.openai.com/v1/responses',
    host: 'api.openai.com',
    path: '/v1/responses',
    headers: {},
    bodyPreview: '{"hello":"world"}',
    agent: { id: 'agent-1', name: 'Test Agent', externalId: null },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    timeoutSeconds: 30,
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
  sdkState.capturedCallback = null;
  sdkState.stopCalls = 0;
  sdkState.ctorCalls = 0;
});

afterEach(() => {
  stopOneCLIBridge();
});

// ── startOneCLIBridge ──────────────────────────────────────────────────────

describe('startOneCLIBridge', () => {
  it('registers a handler for ONECLI_ACTION on the C2 primitive', () => {
    expect(getApprovalHandler(ONECLI_ACTION)).toBeUndefined();

    startOneCLIBridge();

    const handler = getApprovalHandler(ONECLI_ACTION);
    expect(handler).toBeDefined();
    expect(typeof handler!.render).toBe('function');
    expect(typeof handler!.applyDecision).toBe('function');
  });

  it('captures the SDK callback so OneCLI can dispatch into us', () => {
    expect(sdkState.capturedCallback).toBeNull();
    startOneCLIBridge();
    expect(sdkState.capturedCallback).toBeTypeOf('function');
  });

  it('is idempotent — second call does not re-instantiate the SDK', () => {
    startOneCLIBridge();
    const first = sdkState.ctorCalls;
    startOneCLIBridge();
    expect(sdkState.ctorCalls).toBe(first);
  });
});

// ── handleRequest ──────────────────────────────────────────────────────────

describe('handleRequest', () => {
  it("returns 'deny' when no eligible approver exists", async () => {
    const decision = await handleRequest(buildRequest());
    expect(decision).toBe('deny');
  });

  it("returns 'deny' when an approver exists but has no reachable DM", async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    // intentionally no ensureUserDm — user has no DM to deliver to

    const decision = await handleRequest(buildRequest());
    expect(decision).toBe('deny');
  });

  it('persists a pending_approvals row when an approver and DM both exist', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    startOneCLIBridge();

    // Kick off handleRequest but don't await — it returns a Promise that
    // only resolves on click or expiry. Inspect DB state mid-flight.
    const pendingPromise = handleRequest(buildRequest());

    // Yield so handleRequest's async work (requestApproval) completes.
    await new Promise((r) => setImmediate(r));

    const ids = [..._getPendingForTest().keys()];
    expect(ids).toHaveLength(1);

    const row = getPendingApproval(ids[0]);
    expect(row).toBeDefined();
    expect(row!.action).toBe(ONECLI_ACTION);
    expect(row!.status).toBe('pending');
    expect(row!.request_id).toBe('onecli-req-001');

    const payload = JSON.parse(row!.payload as string);
    expect(payload.onecli_request_id).toBe('onecli-req-001');
    expect(payload.method).toBe('POST');
    expect(payload.host).toBe('api.openai.com');

    // Resolve the in-flight promise so it doesn't leak into other tests.
    const handler = getApprovalHandler(ONECLI_ACTION)!;
    await handler.applyDecision!({ approvalId: ids[0], payload, decision: 'rejected' });
    await pendingPromise;
  });

  it('scopes approver lookup to the agent group when externalId resolves to a folder', async () => {
    const ag = createAgentGroup({ name: 'G', folder: 'g' });

    ensureUser({ id: 'telegram:scoped', kind: 'telegram' });
    grantRole({ user_id: 'telegram:scoped', role: 'admin', agent_group_id: ag.id });
    await ensureUserDm({ user_id: 'telegram:scoped', channel_type: 'telegram' });

    startOneCLIBridge();

    const pendingPromise = handleRequest(
      buildRequest({ agent: { id: 'a', name: 'a', externalId: 'g' } }),
    );
    await new Promise((r) => setImmediate(r));

    const [approvalId] = [..._getPendingForTest().keys()];
    expect(approvalId).toBeDefined();
    const row = getPendingApproval(approvalId)!;
    expect(row.agent_group_id).toBe(ag.id);

    // Resolve so the test cleans up.
    const handler = getApprovalHandler(ONECLI_ACTION)!;
    const persistedPayload = JSON.parse(row.payload as string);
    await handler.applyDecision!({
      approvalId,
      payload: persistedPayload,
      decision: 'rejected',
    });
    await pendingPromise;
  });
});

// ── handler.applyDecision wiring ───────────────────────────────────────────

describe('applyDecision integration', () => {
  it("decision='approved' resolves the in-flight Promise with 'approve'", async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    startOneCLIBridge();
    const pendingPromise = handleRequest(buildRequest());
    await new Promise((r) => setImmediate(r));

    const [approvalId] = [..._getPendingForTest().keys()];
    const handler = getApprovalHandler(ONECLI_ACTION)!;
    await handler.applyDecision!({
      approvalId,
      payload: {},
      decision: 'approved',
    });

    await expect(pendingPromise).resolves.toBe('approve');
    expect(_getPendingForTest().has(approvalId)).toBe(false);
  });

  it("decision='rejected' resolves the in-flight Promise with 'deny'", async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    startOneCLIBridge();
    const pendingPromise = handleRequest(buildRequest());
    await new Promise((r) => setImmediate(r));

    const [approvalId] = [..._getPendingForTest().keys()];
    const handler = getApprovalHandler(ONECLI_ACTION)!;
    await handler.applyDecision!({
      approvalId,
      payload: {},
      decision: 'rejected',
    });

    await expect(pendingPromise).resolves.toBe('deny');
    expect(_getPendingForTest().has(approvalId)).toBe(false);
  });

  it('applyDecision on an unknown approvalId is a no-op (does not throw)', () => {
    startOneCLIBridge();
    const handler = getApprovalHandler(ONECLI_ACTION)!;
    expect(() =>
      handler.applyDecision!({
        approvalId: 'never-existed',
        payload: {},
        decision: 'approved',
      }),
    ).not.toThrow();
  });
});

// ── expiry timer ───────────────────────────────────────────────────────────

describe('expiry timer', () => {
  it("times out and resolves with 'deny' when no decision arrives", async () => {
    vi.useFakeTimers();
    try {
      ensureUser({ id: 'telegram:owner', kind: 'telegram' });
      grantRole({ user_id: 'telegram:owner', role: 'owner' });
      await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

      startOneCLIBridge();

      // expiresAt 5s in the future → timer fires at +4s.
      const pendingPromise = handleRequest(
        buildRequest({ expiresAt: new Date(Date.now() + 5_000).toISOString() }),
      );

      // Let the async setup (DB writes) resolve before advancing timers.
      await vi.advanceTimersByTimeAsync(0);

      // The timer is `Math.max(1000, expiresAtMs - now - 1000)` ms ahead.
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pendingPromise).resolves.toBe('deny');
      expect(_getPendingForTest().size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── stopOneCLIBridge ───────────────────────────────────────────────────────

describe('stopOneCLIBridge', () => {
  it('clears pending state and calls SDK handle.stop()', async () => {
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });
    await ensureUserDm({ user_id: 'telegram:owner', channel_type: 'telegram' });

    startOneCLIBridge();
    const pendingPromise = handleRequest(buildRequest());
    await new Promise((r) => setImmediate(r));

    expect(_getPendingForTest().size).toBe(1);
    expect(sdkState.stopCalls).toBe(0);

    stopOneCLIBridge();

    expect(sdkState.stopCalls).toBe(1);
    expect(_getPendingForTest().size).toBe(0);

    // The Promise from the cleared waiter is now orphaned. Resolve it via
    // a manual race so the test runner doesn't see a dangling unresolved
    // promise — but assert that stopOneCLIBridge is non-throwing first.
    void pendingPromise.catch(() => undefined);
  });

  it('is idempotent — second stop is a no-op', () => {
    startOneCLIBridge();
    stopOneCLIBridge();
    expect(sdkState.stopCalls).toBe(1);
    stopOneCLIBridge();
    expect(sdkState.stopCalls).toBe(1);
  });
});
