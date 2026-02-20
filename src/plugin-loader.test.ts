import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { parseManifest, collectContainerEnvVars, collectSkillPaths, collectContainerHookPaths, mergeMcpConfigs, PluginRegistry } from './plugin-loader.js';

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
