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

import { DATA_DIR, MAIN_GROUP_FOLDER } from './config.js';
import {
  createMessagingGroup,
  createWiring,
  getAgentGroupByFolder,
  getAgentGroupById,
  getMessagingGroup,
  getWiring,
} from './db/agent-groups.js';
import { getDb } from './db/init.js';
import { logger } from './logger.js';
import { grantRole, listOwners } from './permissions/user-roles.js';
import { ensureUser } from './permissions/users.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from './types.js';

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
  /**
   * Canonical `<channel>:<handle>` identity of the sender. Required for the
   * intent='main' bootstrap path to grant the consuming user the owner role
   * and seed `user_dms`. Channel plugins build this from their per-channel
   * handle (Telegram: `telegram:<from.id>`, WhatsApp: `whatsapp:<phone>`).
   * When omitted, registration still succeeds but no role/DM is seeded.
   */
  senderUserId?: string | null;
  platformId: string;
  isGroup?: boolean;
  name?: string | null;
  /** Optional raw candidate captured before regex extraction (for audit). */
  candidate?: string;
}

export interface PairingRegistration {
  agent_group_id: string;
  messaging_group_id: string;
}

export type ConsumePendingCodeResult =
  | {
      matched: true;
      intent: PairingIntent;
      record: PendingCodeRecord;
      /**
       * Entity-model rows created (or already-present) for this pairing. Null
       * when registration could not complete — `registration_error` carries a
       * short human-readable explanation in that case so the channel plugin
       * can surface it instead of the default "✓ paired" message.
       */
      registered: PairingRegistration | null;
      registration_error?: string;
    }
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

    // `channel: 'any'` codes (issued by /register-group) are channel-agnostic
    // — they can be claimed from any channel. Channel-pinned codes (legacy
    // /pair-telegram) only match consume attempts from that exact channel.
    const channelMatches = (recordChannel: string) =>
      recordChannel === 'any' || recordChannel === input.channel;

    const record = store.pairings.find(
      (r) => r.code === candidate && r.status === 'pending' && channelMatches(r.channel),
    );

    if (!record) {
      // Wrong-code on any pending entry for the same channel (or 'any')
      // invalidates that entry — matches v2's auto-regenerate behaviour.
      // Codes pinned to a different channel are untouched so a stray Discord
      // guess does not nuke a Telegram-pinned pairing.
      let invalidated = false;
      for (const r of store.pairings) {
        if (r.status !== 'pending') continue;
        if (!channelMatches(r.channel)) continue;
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

    // Register the chat in the entity model so the next inbound message
    // routes to the agent. Registration failures do NOT invalidate the
    // consume — we still report matched: true and surface the error so
    // the plugin can show a clearer message to the operator. Mirrors the
    // existing IPC `register_group` path which calls the same accessors.
    let registered: PairingRegistration | null = null;
    let registrationError: string | undefined;
    try {
      // record.channel may be 'any' (channel-agnostic /register-group code) —
      // that's a routing wildcard for the pending-code lookup, not a channel
      // identity for the resulting wiring. The wiring needs the concrete
      // channel the consume came from so resolveAgentsForInbound(channel, jid)
      // can find it on subsequent inbound traffic.
      registered = registerForIntent({
        intent: record.intent,
        channel: input.channel,
        platformId: input.platformId,
        name: input.name ?? null,
        isGroup: input.isGroup ?? false,
      });
    } catch (err) {
      registrationError = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          code: record.code,
          channel: record.channel,
          platformId: input.platformId,
          intent: record.intent,
          err: registrationError,
        },
        'Pairing matched but entity-model registration failed',
      );
    }

    if (registered) {
      logger.info(
        {
          code: record.code,
          channel: record.channel,
          platformId: input.platformId,
          intent: record.intent,
          agent_group_id: registered.agent_group_id,
          messaging_group_id: registered.messaging_group_id,
        },
        'Paired chat registered in entity model',
      );

      // intent='main' first-pair bootstrap: when no owner exists yet, the
      // consuming user becomes the global owner AND (for DMs) gets a
      // user_dms row pointing at the messaging_group they just paired in.
      // Without this, every approval-card path returns hasApprover:false /
      // no-DM-target on a fresh install and operators have to hand-craft
      // SQL inserts to unblock approvals.
      if (record.intent === 'main') {
        bootstrapOwnerForMainPair({
          channel: input.channel,
          senderUserId: input.senderUserId ?? null,
          senderDisplay: input.sender ?? null,
          messagingGroupId: registered.messaging_group_id,
          isGroup: input.isGroup ?? false,
        });
      }
    }

    return {
      matched: true,
      intent: record.intent,
      record,
      registered,
      registration_error: registrationError,
    };
  });
}

/**
 * Grant the consuming user the global owner role on first main-pair, and
 * (for DMs) seed user_dms so approval-card delivery can reach them. No-op
 * when an owner already exists or `senderUserId` is missing — older channel
 * plugins that don't pass the canonical id will skip this path and the
 * operator can fall back to /grant + manual user_dms insert.
 *
 * Idempotent: re-running on an already-bootstrapped install is a no-op via
 * `listOwners().length === 0` guard plus INSERT OR IGNORE.
 */
function bootstrapOwnerForMainPair(args: {
  channel: string;
  senderUserId: string | null;
  senderDisplay: string | null;
  messagingGroupId: string;
  isGroup: boolean;
}): void {
  if (!args.senderUserId) {
    logger.warn(
      { channel: args.channel, isGroup: args.isGroup },
      'pair-main consumed without senderUserId — skipping owner bootstrap (older plugin?)',
    );
    return;
  }
  if (listOwners().length > 0) return;

  try {
    ensureUser({
      id: args.senderUserId,
      kind: args.channel,
      display_name: args.senderDisplay ?? null,
    });
    grantRole({
      user_id: args.senderUserId,
      role: 'owner',
      granted_by: args.senderUserId,
    });

    if (!args.isGroup) {
      const now = new Date().toISOString();
      getDb()
        .prepare(
          `INSERT OR IGNORE INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)`,
        )
        .run(args.senderUserId, args.channel, args.messagingGroupId, now);
    }

    logger.info(
      {
        user_id: args.senderUserId,
        channel: args.channel,
        seededUserDm: !args.isGroup,
      },
      'pair-main bootstrap: granted owner role to first user',
    );
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        user_id: args.senderUserId,
        channel: args.channel,
      },
      'pair-main bootstrap failed — owner not granted, operator may need /grant',
    );
  }
}

/**
 * Resolve the target agent_group from a pairing intent and persist the
 * `messaging_groups` row + `messaging_group_agents` wiring so the next
 * inbound message from `platformId` routes to that agent.
 *
 * Intent shapes accepted:
 *   - 'main' (string)                           → register against the agent
 *                                                 group with folder ===
 *                                                 MAIN_GROUP_FOLDER
 *   - { kind: 'agent_group', target: '<id>' }   → register against that
 *                                                 specific agent group by id
 *
 * Throws on no-resolvable-agent-group or unknown intent shape so the caller
 * can surface a helpful error to the operator.
 *
 * Idempotent: if a (messaging_group, agent_group) wiring already exists,
 * returns the existing row pair instead of inserting duplicates.
 */
function registerForIntent(args: {
  intent: PairingIntent;
  channel: string;
  platformId: string;
  name: string | null;
  isGroup: boolean;
}): PairingRegistration {
  const ag = resolveAgentGroupForIntent(args.intent);

  let mg: MessagingGroup | undefined = getMessagingGroup(args.channel, args.platformId);
  if (!mg) {
    mg = createMessagingGroup({
      channel_type: args.channel,
      platform_id: args.platformId,
      name: args.name,
      is_group: args.isGroup ? 1 : 0,
    });
  }

  let wiring: MessagingGroupAgent | undefined = getWiring(mg.id, ag.id);
  if (!wiring) {
    // DMs default to engage_mode='always' so the bot responds to every
    // message without requiring a trigger prefix. Group chats keep the
    // 'pattern' default (require @<assistant-name> mention). The operator
    // can flip either via UPDATE messaging_group_agents SET engage_mode=...
    // post-hoc.
    wiring = createWiring({
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: args.isGroup ? 'pattern' : 'always',
    });
  }

  return { agent_group_id: ag.id, messaging_group_id: mg.id };
}

function resolveAgentGroupForIntent(intent: PairingIntent): AgentGroup {
  if (typeof intent === 'string') {
    if (intent === 'main') {
      const ag = getAgentGroupByFolder(MAIN_GROUP_FOLDER);
      if (!ag) {
        throw new Error(`no main agent group (folder='${MAIN_GROUP_FOLDER}')`);
      }
      return ag;
    }
    throw new Error(`unsupported pairing intent: ${intent}`);
  }
  if (intent && typeof intent === 'object') {
    const kind = (intent as { kind?: unknown }).kind;
    const target = (intent as { target?: unknown }).target;
    if (kind === 'agent_group' && typeof target === 'string' && target.length > 0) {
      const ag = getAgentGroupById(target);
      if (!ag) {
        throw new Error(`agent group not found: ${target}`);
      }
      return ag;
    }
  }
  throw new Error(`unsupported pairing intent: ${JSON.stringify(intent)}`);
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
