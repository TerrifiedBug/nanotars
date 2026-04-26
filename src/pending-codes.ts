/**
 * Cross-channel pairing-codes primitive.
 *
 * Generic pairing-code store used by channel plugins to prove that the
 * operator owns the chat they are registering. The setup flow (or an
 * admin slash-command like /pair-telegram) allocates a 4-digit code via
 * `createPendingCode`. The operator echoes the code back from the chat
 * they want to register, and the channel plugin's inbound handler calls
 * `consumePendingCode` BEFORE delivering the message to the agent.
 *
 * Adopted from upstream nanoclaw v2 src/channels/telegram-pairing.ts —
 * generalised so Discord/Slack/etc. can adopt the same flow later. The
 * code-extraction logic (per-channel mention syntax, etc.) stays in the
 * plugin; this module only owns the state machine.
 *
 * Storage: data/pending-codes.json — single-process, in-process mutex,
 * atomic tmp+rename writes. Codes default to a 1-hour TTL configurable
 * via PENDING_CODE_TTL_MS (set to 0 to disable expiry). A wrong-code
 * guess against any pending entry invalidates that entry — matches v2's
 * auto-regenerate behaviour where the operator restarts pairing if they
 * fat-finger the code.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export type PairingIntent = string | Record<string, unknown>;

export type PairingStatus = 'pending' | 'consumed' | 'invalidated' | 'expired';

export interface ConsumedDetails {
  platformId: string;
  isGroup: boolean;
  name: string | null;
  sender: string | null;
  consumedAt: string;
}

export interface PairingAttempt {
  candidate: string;
  platformId: string;
  at: string;
  matched: boolean;
}

export interface PendingCodeRecord {
  code: string;
  channel: string;
  intent: PairingIntent;
  created_at: string;
  expires_at: string | null;
  status: PairingStatus;
  consumed: ConsumedDetails | null;
  attempts: PairingAttempt[];
}

export interface CreatePendingCodeInput {
  channel: string;
  intent: PairingIntent;
}

export interface CreatePendingCodeResult {
  code: string;
  created_at: string;
  expires_at: string | null;
}

export interface ConsumePendingCodeInput {
  code: string;
  channel: string;
  sender?: string | null;
  platformId: string;
  isGroup?: boolean;
  name?: string | null;
  /** Optional raw candidate captured before regex extraction (for audit). */
  candidate?: string;
}

export type ConsumePendingCodeResult =
  | { matched: true; intent: PairingIntent; record: PendingCodeRecord }
  | { matched: false; invalidated: boolean };

export interface PendingCodeStatus {
  status: PairingStatus | 'unknown';
  consumed?: ConsumedDetails | null;
  attempts?: PairingAttempt[];
}

const FILE_NAME = 'pending-codes.json';
const MAX_ATTEMPTS_PER_RECORD = 10;
const MAX_RETAINED_RECORDS = 50;
const CODE_GENERATION_RETRIES = 100;

function defaultTtlMs(): number {
  const raw = process.env.PENDING_CODE_TTL_MS;
  if (raw === undefined || raw === '') return 60 * 60 * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 60 * 60 * 1000;
  return parsed;
}

let storePathOverride: string | null = null;

/** Test helper — point the store at a writable directory. */
export function _setStorePathForTest(p: string | null): void {
  storePathOverride = p;
}

function storePath(): string {
  return storePathOverride ?? path.join(DATA_DIR, FILE_NAME);
}

interface Store {
  pairings: PendingCodeRecord[];
}

let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = mutex.then(() => fn());
  mutex = next.catch(() => {});
  return next;
}

function readStore(): Store {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || !Array.isArray(parsed.pairings)) return { pairings: [] };
    return parsed;
  } catch {
    return { pairings: [] };
  }
}

function writeStore(store: Store): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, p);
}

/** Drop oldest non-pending records when the store exceeds the retention cap. */
function sweep(store: Store): void {
  if (store.pairings.length <= MAX_RETAINED_RECORDS) return;
  store.pairings = store.pairings.slice(-MAX_RETAINED_RECORDS);
}

/** Mutate any pending records past their expiry to status='expired'. */
function expireAged(store: Store, now: number): void {
  for (const r of store.pairings) {
    if (r.status !== 'pending') continue;
    if (!r.expires_at) continue;
    if (now > new Date(r.expires_at).getTime()) {
      r.status = 'expired';
    }
  }
}

function generateCode(active: Set<string>): string {
  // 4-digit numeric, zero-padded. 10k slot space — fine for one-at-a-time use.
  for (let i = 0; i < CODE_GENERATION_RETRIES; i++) {
    const code = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, '0');
    if (!active.has(code)) return code;
  }
  throw new Error('Could not allocate a free pending code (too many active).');
}

export async function createPendingCode(
  input: CreatePendingCodeInput,
): Promise<CreatePendingCodeResult> {
  return withLock(() => {
    const store = readStore();
    const now = Date.now();
    expireAged(store, now);
    sweep(store);
    const active = new Set(
      store.pairings.filter((r) => r.status === 'pending').map((r) => r.code),
    );
    const ttl = defaultTtlMs();
    const created_at = new Date(now).toISOString();
    const expires_at = ttl > 0 ? new Date(now + ttl).toISOString() : null;
    const record: PendingCodeRecord = {
      code: generateCode(active),
      channel: input.channel,
      intent: input.intent,
      created_at,
      expires_at,
      status: 'pending',
      consumed: null,
      attempts: [],
    };
    store.pairings.push(record);
    writeStore(store);
    logger.info(
      { code: record.code, channel: record.channel, intent: record.intent },
      'Pending pairing code created',
    );
    return { code: record.code, created_at, expires_at };
  });
}

export async function consumePendingCode(
  input: ConsumePendingCodeInput,
): Promise<ConsumePendingCodeResult> {
  return withLock(() => {
    const store = readStore();
    const now = Date.now();
    expireAged(store, now);
    sweep(store);
    const candidate = input.code.trim();
    const attempt: PairingAttempt = {
      candidate,
      platformId: input.platformId,
      at: new Date(now).toISOString(),
      matched: false,
    };

    const record = store.pairings.find(
      (r) => r.code === candidate && r.status === 'pending' && r.channel === input.channel,
    );

    if (!record) {
      // Wrong-code on any pending entry for the same channel invalidates that
      // entry — matches v2's auto-regenerate behaviour. Other channels are
      // untouched so a stray Discord guess does not nuke a Telegram pairing.
      let invalidated = false;
      for (const r of store.pairings) {
        if (r.status !== 'pending') continue;
        if (r.channel !== input.channel) continue;
        r.attempts = [...r.attempts, attempt].slice(-MAX_ATTEMPTS_PER_RECORD);
        r.status = 'invalidated';
        invalidated = true;
      }
      if (invalidated) writeStore(store);
      logger.info(
        { candidate, channel: input.channel, platformId: input.platformId, invalidated },
        'Pending pairing code consume miss',
      );
      return { matched: false, invalidated };
    }

    record.status = 'consumed';
    record.consumed = {
      platformId: input.platformId,
      isGroup: input.isGroup ?? false,
      name: input.name ?? null,
      sender: input.sender ?? null,
      consumedAt: new Date(now).toISOString(),
    };
    record.attempts = [...record.attempts, { ...attempt, matched: true }].slice(
      -MAX_ATTEMPTS_PER_RECORD,
    );
    writeStore(store);
    logger.info(
      { code: record.code, channel: record.channel, platformId: input.platformId, intent: record.intent },
      'Pending pairing code consumed',
    );
    return { matched: true, intent: record.intent, record };
  });
}

export function getPendingCodeStatus(code: string): PendingCodeStatus {
  const store = readStore();
  const now = Date.now();
  expireAged(store, now);
  const r = store.pairings.find((p) => p.code === code);
  if (!r) return { status: 'unknown' };
  return {
    status: r.status,
    consumed: r.consumed,
    attempts: r.attempts,
  };
}

/** Test helper — wipe the store. */
export function _resetForTest(): void {
  try {
    fs.unlinkSync(storePath());
  } catch {
    // ignore
  }
}
