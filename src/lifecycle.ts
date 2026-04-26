// src/lifecycle.ts
/**
 * Process-level pause gate. EXTENDS v1's existing GroupQueue.emergencyStop —
 * does not replace. While paused:
 *   - GroupQueue.runForGroup / enqueueMessageCheck no-op.
 *   - In-flight containers complete their current turn.
 *   - Inbound messages still ingest into the messages table; agents just
 *     don't wake until resume.
 *
 * Mirrors v2's modules/lifecycle/index.ts in shape, but layered on top of
 * v1's existing kill-on-emergency path rather than replacing it.
 *
 * Not persisted across restarts (matches v2 + v1 emergencyStop behavior).
 */

import { logger } from './logger.js';

let paused = false;

export const pausedGate = {
  isPaused(): boolean {
    return paused;
  },
  pause(reason: string): void {
    if (paused) {
      logger.info({ reason }, 'pausedGate.pause: already paused');
      return;
    }
    paused = true;
    logger.warn({ reason }, 'pausedGate: paused — new container wakes blocked');
  },
  resume(reason: string): void {
    if (!paused) {
      logger.info({ reason }, 'pausedGate.resume: not paused');
      return;
    }
    paused = false;
    logger.warn({ reason }, 'pausedGate: resumed — container wakes re-enabled');
  },
};

/** @internal - tests only */
export function _resetPausedGate(): void {
  paused = false;
}
