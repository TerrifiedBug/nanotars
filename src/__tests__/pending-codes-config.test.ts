/**
 * Integration test — confirms the createPendingCode / consumePendingCode caps
 * wired into ChannelPluginConfig from src/index.ts behave the same as the
 * underlying module functions.
 *
 * We don't boot the full host; we just rebuild the same closures the host
 * uses (see src/index.ts lines wiring `createPendingCode` and
 * `consumePendingCode` into the channel config) and exercise them end-to-end.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase } from '../db/init.js';
import { createAgentGroup, resolveAgentsForInbound } from '../db/agent-groups.js';
import type { ChannelPluginConfig } from '../plugin-types.js';
import {
  _setStorePathForTest,
  createPendingCode,
  consumePendingCode,
} from '../pending-codes.js';

let tmpDir: string;

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-codes-config-test-'));
  _setStorePathForTest(path.join(tmpDir, 'pending-codes.json'));
});

afterEach(() => {
  _setStorePathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Mirrors how src/index.ts wires the caps into channelConfig. */
function buildPairingCaps(): Pick<ChannelPluginConfig, 'createPendingCode' | 'consumePendingCode'> {
  return {
    createPendingCode: (req) => createPendingCode(req),
    consumePendingCode: async (req) => {
      const result = await consumePendingCode(req);
      if (result.matched) {
        return {
          matched: true,
          intent: result.intent,
          registered: result.registered,
          registration_error: result.registration_error,
        };
      }
      return { matched: false, invalidated: result.invalidated };
    },
  };
}

describe('ChannelPluginConfig pending-codes caps', () => {
  it('createPendingCode → consumePendingCode happy path returns the intent', async () => {
    const caps = buildPairingCaps();
    const { code } = await caps.createPendingCode!({ channel: 'telegram', intent: 'main' });
    const result = await caps.consumePendingCode!({
      code,
      channel: 'telegram',
      sender: 'op',
      platformId: 'tg:42',
      isGroup: false,
      name: 'Op',
    });
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.intent).toBe('main');
  });

  it('non-matching code is reported with invalidated flag', async () => {
    const caps = buildPairingCaps();
    const { code } = await caps.createPendingCode!({ channel: 'telegram', intent: 'main' });
    const wrong = code === '0000' ? '1111' : '0000';
    const result = await caps.consumePendingCode!({
      code: wrong,
      channel: 'telegram',
      platformId: 'tg:1',
    });
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.invalidated).toBe(true);
  });

  it('caps shape matches ChannelPluginConfig signature (compile-only check)', () => {
    const caps = buildPairingCaps();
    // Both are present & callable.
    expect(typeof caps.createPendingCode).toBe('function');
    expect(typeof caps.consumePendingCode).toBe('function');
  });

  it('end-to-end: create → consume → next inbound resolves an agent for the chat', async () => {
    const ag = createAgentGroup({ name: 'Main', folder: 'main' });
    const caps = buildPairingCaps();
    const { code } = await caps.createPendingCode!({ channel: 'telegram', intent: 'main' });
    const result = await caps.consumePendingCode!({
      code,
      channel: 'telegram',
      platformId: 'tg:202',
      isGroup: false,
      name: 'OperatorChat',
    });
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.registered?.agent_group_id).toBe(ag.id);
      expect(result.registration_error).toBeUndefined();
    }
    // Without the Step A registration this would be []. With it, the
    // routing resolver finds the new wiring and the next inbound message
    // will be routed to the agent group.
    const resolved = resolveAgentsForInbound('telegram', 'tg:202');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].agentGroup.id).toBe(ag.id);
  });

  it('match without a main agent group surfaces registration_error to the plugin', async () => {
    // No agent groups exist — match still happens, registration fails.
    const caps = buildPairingCaps();
    const { code } = await caps.createPendingCode!({ channel: 'telegram', intent: 'main' });
    const result = await caps.consumePendingCode!({
      code,
      channel: 'telegram',
      platformId: 'tg:404',
    });
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.registered).toBeNull();
      expect(result.registration_error).toMatch(/no main agent group/i);
    }
  });
});
