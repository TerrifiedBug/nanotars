import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { _setStorePathForTest } from '../../pending-codes.js';
import { runPairMain } from '../pair-main.js';

let tmpDir: string;
let pluginsDir: string;

function writeChannelPlugin(name: string, body: Record<string, unknown> = {}): void {
  const dir = path.join(pluginsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ name, channelPlugin: true, ...body }),
  );
}

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-main-test-'));
  pluginsDir = path.join(tmpDir, 'plugins-channels');
  fs.mkdirSync(pluginsDir, { recursive: true });
  _setStorePathForTest(path.join(tmpDir, 'pending-codes.json'));
});

afterEach(() => {
  _setStorePathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runPairMain', () => {
  it('seeds agent_groups[main] when missing', async () => {
    writeChannelPlugin('telegram');
    expect(getAgentGroupByFolder('main')).toBeUndefined();

    const result = await runPairMain({ channelPluginsDir: pluginsDir, skipDbInit: true });

    expect(result.seededAgentGroup).toBe(true);
    expect(getAgentGroupByFolder('main')).toBeDefined();
    expect(getAgentGroupByFolder('main')?.folder).toBe('main');
  });

  it('leaves agent_groups[main] alone when present', async () => {
    writeChannelPlugin('telegram');
    const existing = createAgentGroup({ name: 'pre-existing', folder: 'main' });

    const result = await runPairMain({ channelPluginsDir: pluginsDir, skipDbInit: true });

    expect(result.seededAgentGroup).toBe(false);
    expect(getAgentGroupByFolder('main')?.id).toBe(existing.id);
    expect(getAgentGroupByFolder('main')?.name).toBe('pre-existing');
  });

  it('issues a 4-digit pending code with intent=main', async () => {
    writeChannelPlugin('telegram');

    const result = await runPairMain({ channelPluginsDir: pluginsDir, skipDbInit: true });

    expect(result.code).toMatch(/^\d{4}$/);
    expect(result.channel).toBe('telegram');
  });

  it('auto-detects the only installed channel', async () => {
    writeChannelPlugin('discord');

    const result = await runPairMain({ channelPluginsDir: pluginsDir, skipDbInit: true });

    expect(result.channel).toBe('discord');
  });

  it('respects an explicit --channel arg even when others are installed', async () => {
    writeChannelPlugin('telegram');
    writeChannelPlugin('discord');

    const result = await runPairMain({
      channel: 'discord',
      channelPluginsDir: pluginsDir,
      skipDbInit: true,
    });

    expect(result.channel).toBe('discord');
  });

  it('refuses to auto-detect when zero channel plugins are installed', async () => {
    await expect(
      runPairMain({ channelPluginsDir: pluginsDir, skipDbInit: true }),
    ).rejects.toThrow(/no channel plugins installed/);
  });

  it('refuses to auto-detect when more than one channel plugin is installed', async () => {
    writeChannelPlugin('telegram');
    writeChannelPlugin('discord');

    await expect(
      runPairMain({ channelPluginsDir: pluginsDir, skipDbInit: true }),
    ).rejects.toThrow(/multiple channel plugins/);
  });

  it('skips entries lacking channelPlugin: true', async () => {
    // Plugin without the channelPlugin flag should NOT count as installed.
    fs.mkdirSync(path.join(pluginsDir, 'not-a-channel'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, 'not-a-channel', 'plugin.json'),
      JSON.stringify({ name: 'not-a-channel' }),
    );
    writeChannelPlugin('telegram');

    const result = await runPairMain({ channelPluginsDir: pluginsDir, skipDbInit: true });
    expect(result.channel).toBe('telegram');
  });

  it('is idempotent: re-running issues a fresh code without re-seeding', async () => {
    writeChannelPlugin('telegram');

    const first = await runPairMain({ channelPluginsDir: pluginsDir, skipDbInit: true });
    const second = await runPairMain({ channelPluginsDir: pluginsDir, skipDbInit: true });

    expect(first.seededAgentGroup).toBe(true);
    expect(second.seededAgentGroup).toBe(false);
    // Codes are independent — the prior one stays valid until consumed/expired.
    expect(second.code).toMatch(/^\d{4}$/);
  });
});
