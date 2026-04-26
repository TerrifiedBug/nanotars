/**
 * Phase 4D D6 — replay-on-approve hook.
 *
 * When an admin approves a pending-sender or pending-channel card, the
 * original inbound message that triggered the request should not be
 * lost — the user expects their first message to get a response, not
 * just to silently become a member who has to message again.
 *
 * Replay surface is intentionally narrow: the orchestrator-side wiring
 * registers a single `ReplayHook` callback at startup; the approval
 * handlers (sender / channel) call the hook with the original
 * `(channel_type, platform_id, sender_handle, message_text)` tuple
 * after addMember/createWiring. The hook re-injects the message
 * through the same path a fresh inbound would take, which by then
 * passes `canAccessAgentGroup` because the addMember happened first.
 *
 * The hook indirection lets:
 *   - The sender-approval / channel-approval modules ship without
 *     reaching into orchestrator internals.
 *   - Tests stub the hook with a vi.fn() and assert replay was invoked
 *     with the right args.
 *   - The host startup register a real implementation that uses
 *     `insertExternalMessage` so the standard message-loop picks up
 *     the replay on the next tick.
 *
 * Concurrency: the hook is best-effort. A throw is caught + logged; we
 * never fail the approval click on a replay error (the membership
 * change is the load-bearing side effect).
 */
import { logger } from '../logger.js';

export interface ReplayInboundArgs {
  channel_type: string;
  /** Chat / group jid the original message arrived on. */
  platform_id: string;
  /** Platform-side sender handle (raw, not namespaced). */
  sender_handle: string;
  /** Best-known display name of the sender. */
  sender_name?: string | null;
  /** The original message text being replayed. */
  message_text: string;
  /** Optional: agent group id we're replaying into. Hook may ignore. */
  agent_group_id?: string;
  /**
   * Trace identifier so the host-side implementation can de-dupe replays
   * (e.g. if both sender + channel approval handlers fire on a single
   * approve click for the same payload). Format suggestion:
   * `replay-<approval_id>` or `replay-<sender_id>-<created_at>`.
   */
  replay_id: string;
}

export type ReplayHook = (args: ReplayInboundArgs) => Promise<void> | void;

let replayHook: ReplayHook | null = null;

/**
 * Register the singleton replay hook. The host startup wires this once;
 * subsequent calls overwrite (with a warn) — same idempotency contract
 * as the approval-handler registry.
 */
export function setReplayHook(hook: ReplayHook): void {
  if (replayHook) {
    logger.warn({}, 'setReplayHook: already registered, overwriting');
  }
  replayHook = hook;
}

export function clearReplayHook(): void {
  replayHook = null;
}

/** Test/diagnostic accessor — returns the currently-registered hook. */
export function getReplayHook(): ReplayHook | null {
  return replayHook;
}

/**
 * Invoke the registered replay hook with the inbound message args.
 * Best-effort: if no hook is registered, logs a debug-level note and
 * returns. If the hook throws, the error is caught and logged — the
 * approval flow's primary side-effect (addMember / createWiring) is
 * already done before this call, so a failed replay only costs the
 * user a message they have to resend.
 */
export async function replayInboundMessage(args: ReplayInboundArgs): Promise<void> {
  if (!replayHook) {
    logger.debug(
      { replay_id: args.replay_id, channel: args.channel_type, platform_id: args.platform_id },
      'replayInboundMessage: no hook registered, skipping',
    );
    return;
  }
  try {
    await replayHook(args);
  } catch (err) {
    logger.warn(
      { replay_id: args.replay_id, channel: args.channel_type, platform_id: args.platform_id, err },
      'replayInboundMessage: hook threw — original message not replayed',
    );
  }
}
