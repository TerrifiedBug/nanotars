import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase, getDb } from '../db/init.js';
import {
  createAgentGroup,
  createMessagingGroup,
  getMessagingGroup,
  getWiringForMessagingGroup,
  resolveAgentsForInbound,
} from '../db/agent-groups.js';
import {
  _setStorePathForTest,
  createPendingCode,
  consumePendingCode,
  getPendingCodeStatus,
} from '../pending-codes.js';

let tmpDir: string;
let storeFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-codes-test-'));
  storeFile = path.join(tmpDir, 'pending-codes.json');
  _setStorePathForTest(storeFile);
  delete process.env.PENDING_CODE_TTL_MS;
});

afterEach(() => {
  _setStorePathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.PENDING_CODE_TTL_MS;
});

describe('createPendingCode', () => {
  it('returns a 4-digit numeric code', async () => {
    const result = await createPendingCode({ channel: 'telegram', intent: 'main' });
    expect(result.code).toMatch(/^\d{4}$/);
    expect(result.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('persists the record to disk', async () => {
    await createPendingCode({ channel: 'telegram', intent: 'main' });
    expect(fs.existsSync(storeFile)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(raw.pairings).toHaveLength(1);
    expect(raw.pairings[0].channel).toBe('telegram');
    expect(raw.pairings[0].intent).toBe('main');
    expect(raw.pairings[0].status).toBe('pending');
  });

  it('emits unique codes for back-to-back creates', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const r = await createPendingCode({ channel: 'telegram', intent: { kind: 'wire', target: `g${i}` } });
      expect(seen.has(r.code)).toBe(false);
      seen.add(r.code);
    }
  });

  it('uses a 1-hour default TTL', async () => {
    const before = Date.now();
    const result = await createPendingCode({ channel: 'telegram', intent: 'main' });
    const expiry = new Date(result.expires_at!).getTime();
    expect(expiry - before).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5_000);
    expect(expiry - before).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
  });

  it('honours PENDING_CODE_TTL_MS=0 → never expires', async () => {
    process.env.PENDING_CODE_TTL_MS = '0';
    const result = await createPendingCode({ channel: 'telegram', intent: 'main' });
    expect(result.expires_at).toBeNull();
  });

  it('atomic write: tmp file is renamed, not left behind', async () => {
    await createPendingCode({ channel: 'telegram', intent: 'main' });
    expect(fs.existsSync(`${storeFile}.tmp`)).toBe(false);
  });
});

describe('consumePendingCode', () => {
  it('matches a pending code on the same channel and marks consumed', async () => {
    const { code } = await createPendingCode({ channel: 'telegram', intent: 'main' });
    const result = await consumePendingCode({
      code,
      channel: 'telegram',
      sender: 'alice',
      platformId: 'tg:123',
      isGroup: false,
      name: 'Alice',
    });
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.intent).toBe('main');
      expect(result.record.consumed?.platformId).toBe('tg:123');
      expect(result.record.consumed?.sender).toBe('alice');
      expect(result.record.status).toBe('consumed');
    }
    expect(getPendingCodeStatus(code).status).toBe('consumed');
  });

  it('handles non-string intent payloads (round-trip)', async () => {
    const intent = { kind: 'wire-to', folder: 'main' };
    const { code } = await createPendingCode({ channel: 'telegram', intent });
    const result = await consumePendingCode({
      code,
      channel: 'telegram',
      platformId: 'tg:1',
    });
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.intent).toEqual(intent);
  });

  it('wrong code invalidates the pending entry on the same channel', async () => {
    const { code } = await createPendingCode({ channel: 'telegram', intent: 'main' });
    const wrong = code === '0000' ? '1111' : '0000';
    const result = await consumePendingCode({
      code: wrong,
      channel: 'telegram',
      platformId: 'tg:42',
    });
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.invalidated).toBe(true);
    expect(getPendingCodeStatus(code).status).toBe('invalidated');
  });

  it('wrong code on a different channel does not invalidate other-channel pendings', async () => {
    const { code } = await createPendingCode({ channel: 'telegram', intent: 'main' });
    const wrong = code === '0000' ? '1111' : '0000';
    const result = await consumePendingCode({
      code: wrong,
      channel: 'discord',
      platformId: 'dc:42',
    });
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.invalidated).toBe(false);
    expect(getPendingCodeStatus(code).status).toBe('pending');
  });

  it('cannot reuse a consumed code', async () => {
    const { code } = await createPendingCode({ channel: 'telegram', intent: 'main' });
    await consumePendingCode({
      code,
      channel: 'telegram',
      platformId: 'tg:1',
    });
    const second = await consumePendingCode({
      code,
      channel: 'telegram',
      platformId: 'tg:2',
    });
    expect(second.matched).toBe(false);
  });

  it('expires codes whose expires_at has passed', async () => {
    process.env.PENDING_CODE_TTL_MS = '1';
    const { code } = await createPendingCode({ channel: 'telegram', intent: 'main' });
    await new Promise((res) => setTimeout(res, 5));
    // Re-read status — should sweep into 'expired'.
    expect(getPendingCodeStatus(code).status).toBe('expired');
    const result = await consumePendingCode({
      code,
      channel: 'telegram',
      platformId: 'tg:1',
    });
    expect(result.matched).toBe(false);
  });

  it('cross-channel match is rejected', async () => {
    const { code } = await createPendingCode({ channel: 'telegram', intent: 'main' });
    const result = await consumePendingCode({
      code,
      channel: 'discord',
      platformId: 'dc:1',
    });
    expect(result.matched).toBe(false);
  });

  it('serialised under the in-process mutex (parallel consumes resolve once)', async () => {
    const { code } = await createPendingCode({ channel: 'telegram', intent: 'main' });
    const [a, b] = await Promise.all([
      consumePendingCode({ code, channel: 'telegram', platformId: 'tg:a' }),
      consumePendingCode({ code, channel: 'telegram', platformId: 'tg:b' }),
    ]);
    const matches = [a, b].filter((r) => r.matched).length;
    expect(matches).toBe(1);
  });
});

describe('consumePendingCode → entity-model registration', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it("intent='main' registers the chat against the main agent group", async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    const { code } = await createPendingCode({ channel: 'telegram', intent: 'main' });
    const result = await consumePendingCode({
      code,
      channel: 'telegram',
      platformId: 'tg:42',
      isGroup: false,
      name: 'Op chat',
    });
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.registered).not.toBeNull();
      expect(result.registered?.agent_group_id).toBe(ag.id);
      expect(result.registration_error).toBeUndefined();

      // Entity-model rows actually exist + the next-message routing
      // resolver returns the new agent group for this chat.
      const mg = getMessagingGroup('telegram', 'tg:42');
      expect(mg).toBeDefined();
      expect(mg!.id).toBe(result.registered!.messaging_group_id);
      expect(mg!.is_group).toBe(0);
      expect(mg!.name).toBe('Op chat');

      const wirings = getWiringForMessagingGroup(mg!.id);
      expect(wirings).toHaveLength(1);
      expect(wirings[0].agent_group_id).toBe(ag.id);

      const resolved = resolveAgentsForInbound('telegram', 'tg:42');
      expect(resolved).toHaveLength(1);
      expect(resolved[0].agentGroup.id).toBe(ag.id);
    }
  });

  it("intent={kind:'agent_group',target:<id>} registers against that specific agent group", async () => {
    createAgentGroup({ name: 'Main', folder: 'main' });
    const ag2 = createAgentGroup({ name: 'Coder', folder: 'coder' });
    const { code } = await createPendingCode({
      channel: 'telegram',
      intent: { kind: 'agent_group', target: ag2.id },
    });
    const result = await consumePendingCode({
      code,
      channel: 'telegram',
      platformId: 'tg:99',
      isGroup: true,
      name: 'Coder Group',
    });
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.registered?.agent_group_id).toBe(ag2.id);
      const mg = getMessagingGroup('telegram', 'tg:99');
      expect(mg!.is_group).toBe(1);
      const wirings = getWiringForMessagingGroup(mg!.id);
      expect(wirings).toHaveLength(1);
      expect(wirings[0].agent_group_id).toBe(ag2.id);
    }
  });

  it('match without a main agent group returns matched=true, registered=null, registration_error', async () => {
    // No agent groups created — main lookup will fail.
    const { code } = await createPendingCode({ channel: 'telegram', intent: 'main' });
    const result = await consumePendingCode({
      code,
      channel: 'telegram',
      platformId: 'tg:1',
    });
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.registered).toBeNull();
      expect(result.registration_error).toMatch(/no main agent group/i);
    }
    // Code is still recorded as consumed (no rollback).
    expect(getPendingCodeStatus(code).status).toBe('consumed');
  });

  it("intent={kind:'agent_group',target:'<missing>'} surfaces a registration error", async () => {
    const { code } = await createPendingCode({
      channel: 'telegram',
      intent: { kind: 'agent_group', target: 'no-such-agent-id' },
    });
    const result = await consumePendingCode({
      code,
      channel: 'telegram',
      platformId: 'tg:7',
    });
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.registered).toBeNull();
      expect(result.registration_error).toMatch(/agent group not found/i);
    }
  });

  it('idempotent: pre-existing wiring for the chat is reused (no duplicate rows)', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    // Pre-seed the messaging_group + wiring as if /chatid had registered first.
    const mg = createMessagingGroup({
      channel_type: 'telegram',
      platform_id: 'tg:55',
      name: 'Pre-registered',
    });
    getDb()
      .prepare(
        `INSERT INTO messaging_group_agents
           (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
            sender_scope, ignored_message_policy, session_mode, priority, created_at)
         VALUES ('pre-wire', ?, ?, 'pattern', NULL, 'all', 'drop', 'shared', 0, ?)`,
      )
      .run(mg.id, ag.id, new Date().toISOString());

    const { code } = await createPendingCode({ channel: 'telegram', intent: 'main' });
    const result = await consumePendingCode({
      code,
      channel: 'telegram',
      platformId: 'tg:55',
    });
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.registered).not.toBeNull();
      expect(result.registered?.messaging_group_id).toBe(mg.id);
      expect(result.registered?.agent_group_id).toBe(ag.id);
      expect(result.registration_error).toBeUndefined();
      // Still exactly one wiring row.
      const wirings = getWiringForMessagingGroup(mg.id);
      expect(wirings).toHaveLength(1);
      expect(wirings[0].id).toBe('pre-wire');
    }
  });
});

describe('getPendingCodeStatus', () => {
  it('returns "unknown" for codes that were never created', () => {
    expect(getPendingCodeStatus('9999').status).toBe('unknown');
  });

  it('exposes attempts captured against the pending entry', async () => {
    const { code } = await createPendingCode({ channel: 'telegram', intent: 'main' });
    const wrong = code === '0000' ? '1111' : '0000';
    await consumePendingCode({ code: wrong, channel: 'telegram', platformId: 'tg:1' });
    const status = getPendingCodeStatus(code);
    expect(status.status).toBe('invalidated');
    expect(status.attempts && status.attempts.length).toBeGreaterThan(0);
    expect(status.attempts![0].matched).toBe(false);
  });
});
