import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getDb } from '../../db/init.js';
import {
  sweepExpiredApprovals,
  startApprovalExpiryPoll,
  stopApprovalExpiryPoll,
} from '../approval-expiry.js';

// Seed a pending_approvals row directly. Bypasses requestApproval so each
// test can pin the exact (status, expires_at) shape it cares about without
// having to set up users / roles / DMs / agent groups.
function seedApproval(args: {
  approval_id: string;
  status?: string;
  expires_at?: string | null;
  action?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO pending_approvals (
        approval_id, session_id, request_id, action, payload, created_at,
        agent_group_id, channel_type, platform_id, platform_message_id,
        expires_at, status, title, options_json
      ) VALUES (?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, '', '[]')`,
    )
    .run(
      args.approval_id,
      args.approval_id, // request_id defaults to approval_id
      args.action ?? 'test_action',
      '{}',
      new Date().toISOString(),
      args.expires_at ?? null,
      args.status ?? 'pending',
    );
}

function getStatus(approvalId: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT status FROM pending_approvals WHERE approval_id = ?`)
    .get(approvalId) as { status: string } | undefined;
  return row?.status;
}

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => {
  // Tests that start the poll must always stop it so timer state doesn't
  // leak across tests.
  stopApprovalExpiryPoll();
});

// ── sweepExpiredApprovals ───────────────────────────────────────────────────

describe('sweepExpiredApprovals', () => {
  it("marks rows with status='pending' and past expires_at as 'expired'", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    seedApproval({ approval_id: 'a1', status: 'pending', expires_at: past });
    seedApproval({ approval_id: 'a2', status: 'pending', expires_at: past });

    const changed = sweepExpiredApprovals();

    expect(changed).toBe(2);
    expect(getStatus('a1')).toBe('expired');
    expect(getStatus('a2')).toBe('expired');
  });

  it("ignores rows with status other than 'pending'", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    seedApproval({ approval_id: 'approved', status: 'approved', expires_at: past });
    seedApproval({ approval_id: 'rejected', status: 'rejected', expires_at: past });
    seedApproval({ approval_id: 'expired', status: 'expired', expires_at: past });

    const changed = sweepExpiredApprovals();

    expect(changed).toBe(0);
    expect(getStatus('approved')).toBe('approved');
    expect(getStatus('rejected')).toBe('rejected');
    expect(getStatus('expired')).toBe('expired');
  });

  it('ignores rows with NULL expires_at (no deadline)', () => {
    seedApproval({ approval_id: 'no-expiry', status: 'pending', expires_at: null });

    const changed = sweepExpiredApprovals();

    expect(changed).toBe(0);
    expect(getStatus('no-expiry')).toBe('pending');
  });

  it('ignores rows with future expires_at', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    seedApproval({ approval_id: 'fut', status: 'pending', expires_at: future });

    const changed = sweepExpiredApprovals();

    expect(changed).toBe(0);
    expect(getStatus('fut')).toBe('pending');
  });

  it('returns 0 and is a no-op when there are no rows', () => {
    const changed = sweepExpiredApprovals();
    expect(changed).toBe(0);
  });

  it('handles a mix: only flips eligible rows', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    seedApproval({ approval_id: 'flip', status: 'pending', expires_at: past });
    seedApproval({ approval_id: 'keep-future', status: 'pending', expires_at: future });
    seedApproval({ approval_id: 'keep-null', status: 'pending', expires_at: null });
    seedApproval({ approval_id: 'keep-approved', status: 'approved', expires_at: past });

    const changed = sweepExpiredApprovals();

    expect(changed).toBe(1);
    expect(getStatus('flip')).toBe('expired');
    expect(getStatus('keep-future')).toBe('pending');
    expect(getStatus('keep-null')).toBe('pending');
    expect(getStatus('keep-approved')).toBe('approved');
  });
});

// ── startApprovalExpiryPoll / stopApprovalExpiryPoll ────────────────────────

describe('startApprovalExpiryPoll', () => {
  it('runs an initial sweep synchronously on startup', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    seedApproval({ approval_id: 'startup', status: 'pending', expires_at: past });

    startApprovalExpiryPoll();

    // Initial sweep ran during the call — no need to advance timers.
    expect(getStatus('startup')).toBe('expired');
  });

  it('continues sweeping on the interval after startup', () => {
    vi.useFakeTimers();
    try {
      // Start with no expired rows.
      startApprovalExpiryPoll();

      // Insert a row whose expiry is now past.
      const past = new Date(Date.now() - 1000).toISOString();
      seedApproval({ approval_id: 'late', status: 'pending', expires_at: past });

      // Before the interval fires, the row is still pending.
      expect(getStatus('late')).toBe('pending');

      // Advance the clock past one interval — sweep should fire.
      vi.advanceTimersByTime(60_000);

      expect(getStatus('late')).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is idempotent: a second start call is a no-op', () => {
    vi.useFakeTimers();
    try {
      startApprovalExpiryPoll();
      // Calling start a second time should not stack a second interval.
      // We verify by checking that the timer count is still 1.
      const before = vi.getTimerCount();
      startApprovalExpiryPoll();
      const after = vi.getTimerCount();
      expect(after).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a sweep error and keeps polling', () => {
    vi.useFakeTimers();
    try {
      startApprovalExpiryPoll();

      // Force the next sweep to throw by closing the underlying DB
      // handle and replacing it with one that throws on prepare. We do
      // this lightly: drop the table out from under the sweep so the
      // UPDATE fails — the catch block in the interval should swallow it.
      getDb().exec(`DROP TABLE pending_approvals`);

      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stopApprovalExpiryPoll', () => {
  it('clears the interval so subsequent ticks do not sweep', () => {
    vi.useFakeTimers();
    try {
      startApprovalExpiryPoll();
      stopApprovalExpiryPoll();

      // Now seed a stale row.
      const past = new Date(Date.now() - 1000).toISOString();
      seedApproval({ approval_id: 'after-stop', status: 'pending', expires_at: past });

      vi.advanceTimersByTime(60_000 * 5);

      // The interval was cleared, so no sweep should have fired.
      expect(getStatus('after-stop')).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is safe to call when no poll is running', () => {
    expect(() => stopApprovalExpiryPoll()).not.toThrow();
  });

  it('is safe to call twice', () => {
    startApprovalExpiryPoll();
    stopApprovalExpiryPoll();
    expect(() => stopApprovalExpiryPoll()).not.toThrow();
  });
});
