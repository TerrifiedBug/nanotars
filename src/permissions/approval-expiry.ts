/**
 * Approval card expiry — periodic time-based sweep.
 *
 * Phase 4C C5: at host startup we walk `pending_approvals` and mark any row
 * whose `expires_at` is past as `status='expired'`. A 60s `setInterval` runs
 * the sweep periodically while the host is alive so cards that age out mid-
 * run also get reaped. The interval is `unref`d so it doesn't keep the event
 * loop alive on its own.
 *
 * Per-row `setTimeout` timers are intentionally not implemented — cancelling
 * them on resolution is fiddly and the periodic poll covers it adequately
 * (worst-case latency: POLL_INTERVAL_MS). If a future feature needs sub-
 * minute expiry latency, extend this module rather than scattering timers
 * across callers.
 *
 * Note: this only flips the `status` column. Best-effort card-text edits
 * ("Expired (host restarted)") via the channel delivery adapter are a
 * separate concern (plan C5's `editCardExpired` / `sweepStaleApprovals`,
 * deferred until the delivery adapter contract lands in C4/C6).
 *
 * Status convention: `pending_approvals.status` defaults to `'pending'`
 * (see APPROVALS_DDL in src/db/init.ts). `'expired'` is one of the four
 * terminal values declared in the plan: pending | approved | rejected |
 * expired.
 */
import { getDb } from '../db/init.js';
import { logger } from '../logger.js';

const POLL_INTERVAL_MS = 60_000; // 1 min — matches typical heartbeat cadence
let pollHandle: NodeJS.Timeout | undefined;

/**
 * Mark every `pending_approvals` row whose `expires_at` is in the past as
 * `status='expired'`. Returns the number of rows changed. Rows with NULL
 * `expires_at`, future `expires_at`, or non-`'pending'` status are left
 * alone. Idempotent.
 */
export function sweepExpiredApprovals(): number {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE pending_approvals
         SET status = 'expired'
       WHERE status = 'pending'
         AND expires_at IS NOT NULL
         AND expires_at < ?`,
    )
    .run(now);
  const count = result.changes as number;
  if (count > 0) {
    logger.info({ count }, 'Approval expiry sweep marked rows expired');
  }
  return count;
}

/**
 * Run an initial sweep, then schedule a periodic sweep on a 60s interval.
 * Idempotent — calling twice is a no-op (the second call is ignored).
 * The interval is `unref`d so it won't keep the Node event loop alive
 * after the rest of the host shuts down.
 */
export function startApprovalExpiryPoll(): void {
  if (pollHandle) return; // already running
  // Run once at startup so we don't wait the full interval before the first sweep.
  sweepExpiredApprovals();
  pollHandle = setInterval(() => {
    try {
      sweepExpiredApprovals();
    } catch (err) {
      logger.warn({ err }, 'Approval expiry sweep failed');
    }
  }, POLL_INTERVAL_MS);
  // Don't keep the event loop alive solely for this poll.
  pollHandle.unref?.();
  logger.info({ intervalMs: POLL_INTERVAL_MS }, 'Approval expiry poll started');
}

/**
 * Stop the periodic sweep. Used in tests and on graceful shutdown.
 */
export function stopApprovalExpiryPoll(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = undefined;
  }
}
