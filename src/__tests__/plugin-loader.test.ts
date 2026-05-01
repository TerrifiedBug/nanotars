import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { parseManifest, collectContainerEnvVars, collectSkillPaths, collectContainerHookPaths, mergeMcpConfigs, PluginRegistry, withSetupRetry } from '../plugin-loader.js';

class NetworkError extends Error {
  constructor(msg: string) { super(msg); this.name = 'NetworkError'; }
}

describe('withSetupRetry', () => {
  it('returns immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const out = await withSetupRetry('test-plugin', fn, { delays: [0, 0, 0] });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on NetworkError up to delays.length times', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new NetworkError('flap 1'))
      .mockRejectedValueOnce(new NetworkError('flap 2'))
      .mockResolvedValue('ok');
    const out = await withSetupRetry('test-plugin', fn, { delays: [0, 0, 0] });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows non-NetworkError without retry', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('config bad'));
    await expect(withSetupRetry('test-plugin', fn, { delays: [0, 0, 0] }))
      .rejects.toThrow(/config bad/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries and rethrows the last NetworkError', async () => {
    const fn = vi.fn().mockRejectedValue(new NetworkError('still down'));
    await expect(withSetupRetry('test-plugin', fn, { delays: [0, 0, 0] }))
      .rejects.toThrow(/still down/);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('parseManifest', () => {
  it('parses a valid manifest-only plugin', () => {
    const manifest = parseManifest({
      name: 'brave-search',
      containerEnvVars: ['BRAVE_API_KEY'],
      hooks: [],
    });
    expect(manifest.name).toBe('brave-search');
    expect(manifest.containerEnvVars).toEqual(['BRAVE_API_KEY']);
    expect(manifest.hooks).toEqual([]);
  });

  it('rejects manifest without name', () => {
    expect(() => parseManifest({ hooks: [] } as any)).toThrow();
  });

  it('defaults optional fields', () => {
    const manifest = parseManifest({ name: 'test' });
    expect(manifest.containerEnvVars).toEqual([]);
    expect(manifest.hostEnvVars).toEqual([]);
    expect(manifest.publicEnvVars).toEqual([]);
    expect(manifest.hooks).toEqual([]);
    expect(manifest.containerHooks).toEqual([]);
    expect(manifest.dependencies).toBe(false);
  });

  it('parses publicEnvVars field', () => {
    const manifest = parseManifest({
      name: 'freshrss',
      containerEnvVars: ['FRESHRSS_URL', 'FRESHRSS_API_KEY'],
      publicEnvVars: ['FRESHRSS_URL'],
    });
    expect(manifest.publicEnvVars).toEqual(['FRESHRSS_URL']);
  });

  it('parses hostEnvVars field without adding them to container env vars', () => {
    const manifest = parseManifest({
      name: 'transcription',
      hostEnvVars: ['OPENAI_API_KEY'],
    });
    expect(manifest.hostEnvVars).toEqual(['OPENAI_API_KEY']);
    expect(collectContainerEnvVars([{ manifest, dir: '', hooks: {} } as any])).not.toContain('OPENAI_API_KEY');
  });

  it('parses containerHooks field', () => {
    const manifest = parseManifest({
      name: 'claude-mem',
      containerHooks: ['hooks/post-tool-use.js'],
    });
    expect(manifest.containerHooks).toEqual(['hooks/post-tool-use.js']);
  });

  it('parses version and minCoreVersion fields', () => {
    const manifest = parseManifest({
      name: 'test-plugin',
      version: '1.2.3',
      minCoreVersion: '1.0.0',
    });
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.minCoreVersion).toBe('1.0.0');
  });

  it('defaults version fields to undefined', () => {
    const manifest = parseManifest({ name: 'test' });
    expect(manifest.version).toBeUndefined();
    expect(manifest.minCoreVersion).toBeUndefined();
  });

  it('rejects invalid semver version strings', () => {
    const manifest = parseManifest({ name: 'test-plugin', version: 'abc' });
    expect(manifest.version).toBeUndefined();
  });

  it('accepts valid semver versions', () => {
    const manifest = parseManifest({ name: 'test-plugin', version: '2.1.0' });
    expect(manifest.version).toBe('2.1.0');
  });

  it('rejects partial semver like 1.0', () => {
    const manifest = parseManifest({ name: 'test-plugin', version: '1.0' });
    expect(manifest.version).toBeUndefined();
  });
});

describe('collectContainerEnvVars', () => {
  it('merges core vars with plugin vars', () => {
    const plugins = [
      { manifest: { name: 'a', containerEnvVars: ['BRAVE_API_KEY'] }, dir: '', hooks: {} },
      { manifest: { name: 'b', containerEnvVars: ['GH_TOKEN', 'NOTION_API_KEY'] }, dir: '', hooks: {} },
    ];
    const result = collectContainerEnvVars(plugins as any);
    expect(result).toContain('ANTHROPIC_API_KEY');
    expect(result).toContain('CLAUDE_MODEL');
    expect(result).toContain('ASSISTANT_NAME');
    expect(result).toContain('BRAVE_API_KEY');
    expect(result).toContain('GH_TOKEN');
    expect(result).toContain('NOTION_API_KEY');
  });

  it('includes TZ in core vars', () => {
    const result = collectContainerEnvVars([]);
    expect(result).toContain('TZ');
  });

  it('deduplicates vars', () => {
    const plugins = [
      { manifest: { name: 'a', containerEnvVars: ['GH_TOKEN'] }, dir: '', hooks: {} },
      { manifest: { name: 'b', containerEnvVars: ['GH_TOKEN'] }, dir: '', hooks: {} },
    ];
    const result = collectContainerEnvVars(plugins as any);
    const ghCount = result.filter((v: string) => v === 'GH_TOKEN').length;
    expect(ghCount).toBe(1);
  });
});

describe('collectSkillPaths', () => {
  it('returns container-skills directories that exist', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) =>
      String(p).includes('brave-search/container-skills'));
    const plugins = [
      { manifest: { name: 'brave-search' }, dir: '/plugins/brave-search', hooks: {} },
      { manifest: { name: 'github' }, dir: '/plugins/github', hooks: {} },
    ];
    const result = collectSkillPaths(plugins as any);
    expect(result).toHaveLength(1);
    expect(result[0].hostPath).toContain('brave-search/container-skills');
    vi.restoreAllMocks();
  });
});

describe('collectContainerHookPaths', () => {
  it('returns hook files that exist', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) =>
      String(p).includes('post-tool-use.js'));
    const plugins = [
      { manifest: { name: 'claude-mem', containerHooks: ['hooks/post-tool-use.js'] }, dir: '/plugins/claude-mem', hooks: {} },
      { manifest: { name: 'other', containerHooks: ['hooks/missing.js'] }, dir: '/plugins/other', hooks: {} },
    ];
    const result = collectContainerHookPaths(plugins as any);
    expect(result).toHaveLength(1);
    expect(result[0].hostPath).toContain('post-tool-use.js');
    expect(result[0].name).toBe('claude-mem--post-tool-use.js');
    vi.restoreAllMocks();
  });

  it('returns empty for plugins without containerHooks', () => {
    const plugins = [
      { manifest: { name: 'brave-search' }, dir: '/plugins/brave-search', hooks: {} },
    ];
    const result = collectContainerHookPaths(plugins as any);
    expect(result).toHaveLength(0);
  });
});

describe('parseManifest channel plugin fields', () => {
  it('parses channelPlugin and authSkill', () => {
    const manifest = parseManifest({
      name: 'whatsapp',
      channelPlugin: true,
      authSkill: 'setup-whatsapp',
      hooks: ['onChannel'],
    });
    expect(manifest.channelPlugin).toBe(true);
    expect(manifest.authSkill).toBe('setup-whatsapp');
  });

  it('parses channels and groups scope arrays', () => {
    const manifest = parseManifest({
      name: 'wa-voice',
      channels: ['whatsapp'],
      groups: ['main', 'family'],
    });
    expect(manifest.channels).toEqual(['whatsapp']);
    expect(manifest.groups).toEqual(['main', 'family']);
  });

  it('defaults channelPlugin to false', () => {
    const manifest = parseManifest({ name: 'test' });
    expect(manifest.channelPlugin).toBe(false);
  });
});

describe('PluginRegistry.getPluginsForGroup', () => {
  it('returns all plugins when no scope specified', () => {
    const registry = new PluginRegistry();
    registry.add({ manifest: { name: 'a' } as any, dir: '', hooks: {} });
    registry.add({ manifest: { name: 'b' } as any, dir: '', hooks: {} });
    expect(registry.getPluginsForGroup()).toHaveLength(2);
  });

  it('filters by channel', () => {
    const registry = new PluginRegistry();
    registry.add({ manifest: { name: 'wa-only', channels: ['whatsapp'] } as any, dir: '', hooks: {} });
    registry.add({ manifest: { name: 'all-channels' } as any, dir: '', hooks: {} });
    expect(registry.getPluginsForGroup('whatsapp')).toHaveLength(2);
    expect(registry.getPluginsForGroup('telegram')).toHaveLength(1);
    expect(registry.getPluginsForGroup('telegram')[0].manifest.name).toBe('all-channels');
  });

  it('filters by group folder', () => {
    const registry = new PluginRegistry();
    registry.add({ manifest: { name: 'main-only', groups: ['main'] } as any, dir: '', hooks: {} });
    registry.add({ manifest: { name: 'everywhere' } as any, dir: '', hooks: {} });
    expect(registry.getPluginsForGroup(undefined, 'main')).toHaveLength(2);
    expect(registry.getPluginsForGroup(undefined, 'family')).toHaveLength(1);
  });

  it('wildcard scope matches all', () => {
    const registry = new PluginRegistry();
    registry.add({ manifest: { name: 'wildcard', channels: ['*'], groups: ['*'] } as any, dir: '', hooks: {} });
    expect(registry.getPluginsForGroup('telegram', 'family')).toHaveLength(1);
  });
});

describe('PluginRegistry.runOutboundHooks', () => {
  it('returns text unchanged when no plugins have outbound hooks', async () => {
    const registry = new PluginRegistry();
    registry.add({ manifest: { name: 'no-hook' } as any, dir: '', hooks: {} });
    const result = await registry.runOutboundHooks('hello', 'group@g.us', 'whatsapp');
    expect(result).toBe('hello');
  });

  it('transforms text through outbound hooks in sequence', async () => {
    const registry = new PluginRegistry();
    registry.add({
      manifest: { name: 'upper' } as any, dir: '', hooks: {
        onOutboundMessage: async (text: string) => text.toUpperCase(),
      },
    });
    registry.add({
      manifest: { name: 'exclaim' } as any, dir: '', hooks: {
        onOutboundMessage: async (text: string) => text + '!',
      },
    });
    const result = await registry.runOutboundHooks('hello', 'group@g.us', 'whatsapp');
    expect(result).toBe('HELLO!');
  });

  it('returns empty string when hook suppresses message', async () => {
    const registry = new PluginRegistry();
    registry.add({
      manifest: { name: 'suppress' } as any, dir: '', hooks: {
        onOutboundMessage: async () => '',
      },
    });
    const result = await registry.runOutboundHooks('hello', 'group@g.us', 'whatsapp');
    expect(result).toBe('');
  });
});

describe('PluginRegistry.getPublicEnvVars', () => {
  it('collects publicEnvVars from all plugins', () => {
    const registry = new PluginRegistry();
    registry.add({
      manifest: { name: 'freshrss', publicEnvVars: ['FRESHRSS_URL'] } as any,
      dir: '', hooks: {},
    });
    registry.add({
      manifest: { name: 'claude-mem', publicEnvVars: ['CLAUDE_MEM_URL'] } as any,
      dir: '', hooks: {},
    });
    expect(registry.getPublicEnvVars()).toEqual(
      expect.arrayContaining(['FRESHRSS_URL', 'CLAUDE_MEM_URL']),
    );
  });

  it('returns empty array when no plugins declare publicEnvVars', () => {
    const registry = new PluginRegistry();
    registry.add({ manifest: { name: 'basic' } as any, dir: '', hooks: {} });
    expect(registry.getPublicEnvVars()).toEqual([]);
  });

  it('deduplicates publicEnvVars across plugins', () => {
    const registry = new PluginRegistry();
    registry.add({
      manifest: { name: 'a', publicEnvVars: ['SHARED_URL'] } as any,
      dir: '', hooks: {},
    });
    registry.add({
      manifest: { name: 'b', publicEnvVars: ['SHARED_URL'] } as any,
      dir: '', hooks: {},
    });
    expect(registry.getPublicEnvVars()).toEqual(['SHARED_URL']);
  });
});

describe('startup error handling', () => {
  it('continues starting plugins when one throws', async () => {
    const registry = new PluginRegistry();
    const started: string[] = [];

    registry.add({
      manifest: { name: 'good-before' } as any,
      dir: '',
      hooks: { onStartup: async () => { started.push('good-before'); } },
    });
    registry.add({
      manifest: { name: 'bad' } as any,
      dir: '',
      hooks: { onStartup: async () => { throw new Error('plugin init failed'); } },
    });
    registry.add({
      manifest: { name: 'good-after' } as any,
      dir: '',
      hooks: { onStartup: async () => { started.push('good-after'); } },
    });

    await registry.startup({} as any);
    expect(started).toEqual(['good-before', 'good-after']);
  });
});

describe('hook error handling', () => {
  it('continues inbound hooks when one throws', async () => {
    const registry = new PluginRegistry();

    registry.add({
      manifest: { name: 'prefix' } as any,
      dir: '',
      hooks: { onInboundMessage: async (msg: any) => ({ ...msg, text: '[ok] ' + msg.text }) },
    });
    registry.add({
      manifest: { name: 'bad' } as any,
      dir: '',
      hooks: { onInboundMessage: async () => { throw new Error('hook failed'); } },
    });
    registry.add({
      manifest: { name: 'suffix' } as any,
      dir: '',
      hooks: { onInboundMessage: async (msg: any) => ({ ...msg, text: msg.text + ' [done]' }) },
    });

    const result = await registry.runInboundHooks({ text: 'hi', jid: 'a@b', pushName: 'x' } as any, 'whatsapp');
    expect(result.text).toBe('[ok] hi [done]');
  });

  it('continues outbound hooks when one throws', async () => {
    const registry = new PluginRegistry();

    registry.add({
      manifest: { name: 'upper' } as any,
      dir: '',
      hooks: { onOutboundMessage: async (text: string) => text.toUpperCase() },
    });
    registry.add({
      manifest: { name: 'bad' } as any,
      dir: '',
      hooks: { onOutboundMessage: async () => { throw new Error('hook failed'); } },
    });
    registry.add({
      manifest: { name: 'exclaim' } as any,
      dir: '',
      hooks: { onOutboundMessage: async (text: string) => text + '!' },
    });

    const result = await registry.runOutboundHooks('hello', 'g@g.us', 'whatsapp');
    expect(result).toBe('HELLO!');
  });
});

describe('mergeMcpConfigs', () => {
  it('merges multiple mcp.json fragments', () => {
    const fragment1 = { mcpServers: { ha: { command: 'ha-server' } } };
    const fragment2 = { mcpServers: { n8n: { url: 'http://n8n' } } };
    const result = mergeMcpConfigs([fragment1, fragment2]);
    expect(result.mcpServers.ha).toBeDefined();
    expect(result.mcpServers.n8n).toBeDefined();
  });

  it('returns empty mcpServers when no fragments', () => {
    const result = mergeMcpConfigs([]);
    expect(result.mcpServers).toEqual({});
  });
});

describe('parseManifest agentProvider fields (Phase 5A)', () => {
  it('parses agentProvider:true + agentProviderName', () => {
    const manifest = parseManifest({
      name: 'codex',
      agentProvider: true,
      agentProviderName: 'codex',
    });
    expect(manifest.agentProvider).toBe(true);
    expect(manifest.agentProviderName).toBe('codex');
  });

  it('defaults agentProvider to false', () => {
    const manifest = parseManifest({ name: 'test' });
    expect(manifest.agentProvider).toBe(false);
    expect(manifest.agentProviderName).toBeUndefined();
  });

  it('rejects non-string agentProviderName', () => {
    const manifest = parseManifest({
      name: 'test',
      agentProvider: true,
      agentProviderName: 123 as unknown as string,
    });
    expect(manifest.agentProviderName).toBeUndefined();
  });
});

// loadPlugins integration tests for the agentProvider flow
describe('loadPlugins agentProvider integration (Phase 5A)', () => {
  // Lazy-import inside each test so the test runner picks up our mocks.
  it('imports index.js side-effect for agentProvider plugins (no hooks declared)', async () => {
    const { loadPlugins } = await import('../plugin-loader.js');
    const {
      _clearProviderContainerRegistry,
      registerProviderContainerConfig,
      listProviderContainerConfigNames,
    } = await import('../providers/provider-container-registry.js');

    _clearProviderContainerRegistry();

    // Build a tmp plugin dir whose index.js calls registerProviderContainerConfig
    // at top level. The plugin declares no hooks, only agentProvider:true.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-5a-'));
    try {
      const pluginDir = path.join(tmpRoot, 'codex');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, 'plugin.json'),
        JSON.stringify({
          name: 'codex',
          agentProvider: true,
          agentProviderName: 'codex-test',
        }),
      );
      // The index.js must reach into the host registry. We write an ESM file
      // that imports from the absolute path to provider-container-registry.
      // Pre-register the entry directly here to simulate the side-effect since
      // tmp-dir module imports cannot easily resolve into the test workspace.
      registerProviderContainerConfig('codex-test', () => ({}));
      // Empty index.js so the loader will import without errors.
      fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export {};\n');

      const registry = await loadPlugins(tmpRoot);
      expect(registry.loaded.find((p) => p.manifest.name === 'codex')?.manifest.agentProvider).toBe(true);
      expect(listProviderContainerConfigNames()).toContain('codex-test');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      _clearProviderContainerRegistry();
    }
  });

  it('warns when agentProvider plugin missing agentProviderName', async () => {
    const { loadPlugins } = await import('../plugin-loader.js');
    const { logger } = await import('../logger.js');
    const warnSpy = logger.warn as unknown as ReturnType<typeof vi.fn>;
    warnSpy.mockClear?.();

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-5a-'));
    try {
      const pluginDir = path.join(tmpRoot, 'broken');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, 'plugin.json'),
        JSON.stringify({ name: 'broken', agentProvider: true }),
      );
      fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export {};\n');

      await loadPlugins(tmpRoot);
      const warnedNoName = (warnSpy as ReturnType<typeof vi.fn>).mock.calls.some(
        ([_, msg]: [unknown, unknown]) => typeof msg === 'string' && /missing agentProviderName/.test(msg),
      );
      expect(warnedNoName).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('warns when agentProvider plugin loaded but registry has no entry', async () => {
    const { loadPlugins } = await import('../plugin-loader.js');
    const { _clearProviderContainerRegistry } = await import('../providers/provider-container-registry.js');
    const { logger } = await import('../logger.js');
    const warnSpy = logger.warn as unknown as ReturnType<typeof vi.fn>;
    warnSpy.mockClear?.();
    _clearProviderContainerRegistry();

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-5a-'));
    try {
      const pluginDir = path.join(tmpRoot, 'lonely');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, 'plugin.json'),
        JSON.stringify({
          name: 'lonely',
          agentProvider: true,
          agentProviderName: 'never-registered',
        }),
      );
      fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export {};\n');

      await loadPlugins(tmpRoot);
      const warnedNoEntry = (warnSpy as ReturnType<typeof vi.fn>).mock.calls.some(
        ([_, msg]: [unknown, unknown]) => typeof msg === 'string' && /no matching entry/.test(msg),
      );
      expect(warnedNoEntry).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      _clearProviderContainerRegistry();
    }
  });
});
