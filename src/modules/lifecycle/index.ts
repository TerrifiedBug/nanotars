/**
 * Host lifecycle controls — emergency stop / resume.
 *
 * While paused:
 *   - `wakeContainer()` is a no-op. Inbound messages still land in
 *     session inbound DBs; they're just not delivered to agents until
 *     resume.
 *   - Existing active containers are killed on entering pause.
 *   - Delivery polls continue to drain already-produced outbound
 *     messages (so messages in flight before the pause still reach
 *     the user). To fully silence output, caller should also stop
 *     delivery polls — not done here to keep the primitive small.
 *
 * Ported from nanotars v1 (src/group-queue.ts emergencyStop +
 * src/orchestrator.ts pause). The v2 version is simpler: a single
 * process-level flag gating spawn, plus a bulk kill.
 *
 * Not persisted across restarts — a crash while paused resumes on
 * boot. That matches v1 behaviour and is desirable: pause is for
 * hot-incident containment, not a durable config state.
 */
import { log } from '../../log.js';

let paused = false;

export function isPaused(): boolean {
  return paused;
}

/**
 * Enter pause. Returns the list of session IDs whose containers were
 * killed. Safe to call when already paused (no-op for the flag, still
 * kills any containers that spawned between pauses).
 */
export async function pause(reason: string): Promise<string[]> {
  const wasPaused = paused;
  paused = true;

  // Lazy import: container-runner imports this module too, and Node ESM
  // can tolerate it but it keeps the initial module graph clean.
  const { killAllContainers } = await import('../../container-runner.js');
  const killed = killAllContainers(`emergency-stop: ${reason}`);

  if (!wasPaused) {
    log.warn('Host paused — new container wakes blocked, existing containers killed', { reason, killed: killed.length });
  } else {
    log.info('Already paused; killed any leftover containers', { killedNow: killed.length });
  }
  return killed;
}

export function resume(reason: string): void {
  if (!paused) {
    log.info('Resume requested but host was not paused', { reason });
    return;
  }
  paused = false;
  log.warn('Host resumed — container wakes re-enabled', { reason });
}
