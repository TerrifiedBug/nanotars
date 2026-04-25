/**
 * Telegram pairing flow.
 *
 * Telegram's BotFather token has no user-binding — anyone who DMs the
 * bot is treated as authorized. This module gates first contact behind
 * a one-time code the operator types into the chat.
 *
 * Lifecycle:
 *   1. Operator runs the pairing skill on the host → generatePairingCode()
 *      returns a short code; the operator pastes it into the Telegram chat.
 *   2. The Telegram channel plugin sees the inbound message containing
 *      the code; calls acceptPairingCode(code, userPlatformId). Returns
 *      true if the code matched and wasn't expired.
 *   3. Subsequent messages from that user are accepted (channel plugin
 *      checks isPaired before forwarding to the orchestrator).
 *
 * State stored in router_state KV under key 'telegram_pairing'.
 *
 * Adopted from upstream nanoclaw v2 src/channels/telegram-pairing.ts.
 */
import { getRouterState, setRouterState } from './db/state.js';

const STATE_KEY = 'telegram_pairing';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface PairingState {
  code: string;
  expires_at: string; // ISO timestamp
  paired_users: string[];
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omits 0/O/1/I for legibility

function loadState(): PairingState {
  const raw = getRouterState(STATE_KEY);
  if (!raw) return { code: '', expires_at: '', paired_users: [] };
  try {
    return JSON.parse(raw) as PairingState;
  } catch {
    return { code: '', expires_at: '', paired_users: [] };
  }
}

function saveState(state: PairingState): void {
  setRouterState(STATE_KEY, JSON.stringify(state));
}

function randomCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/**
 * Generate a new pairing code and persist it. Overwrites any pending code.
 * Returns the code so the caller can show it to the operator.
 */
export function generatePairingCode(): string {
  const code = randomCode();
  const expires_at = new Date(Date.now() + CODE_TTL_MS).toISOString();
  const existing = loadState();
  saveState({ code, expires_at, paired_users: existing.paired_users });
  return code;
}

/**
 * Try to accept a pairing code submission from a Telegram user.
 * Returns true if the code matched, hasn't expired, and the user isn't
 * already paired. On success, marks the user as paired and clears the
 * pending code (so it can't be reused).
 */
export function acceptPairingCode(submittedCode: string, userPlatformId: string): boolean {
  const state = loadState();
  if (!state.code) return false;
  if (state.code !== submittedCode) return false;
  if (Date.now() > new Date(state.expires_at).getTime()) return false;
  if (state.paired_users.includes(userPlatformId)) return false;
  saveState({
    code: '',
    expires_at: '',
    paired_users: [...state.paired_users, userPlatformId],
  });
  return true;
}

/** Whether a Telegram user has completed pairing. */
export function isPaired(userPlatformId: string): boolean {
  return loadState().paired_users.includes(userPlatformId);
}

/** Wipe all pairing state — admin operation. */
export function clearPairing(): void {
  saveState({ code: '', expires_at: '', paired_users: [] });
}
