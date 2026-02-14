import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { parseManifest, collectContainerEnvVars, collectSkillPaths, mergeMcpConfigs } from './plugin-loader.js';

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
    expect(manifest.hooks).toEqual([]);
    expect(manifest.dependencies).toBe(false);
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
  it('returns skill directories that exist', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) =>
      String(p).includes('brave-search/skills'));
    const plugins = [
      { manifest: { name: 'brave-search' }, dir: '/plugins/brave-search', hooks: {} },
      { manifest: { name: 'github' }, dir: '/plugins/github', hooks: {} },
    ];
    const result = collectSkillPaths(plugins as any);
    expect(result).toHaveLength(1);
    expect(result[0].hostPath).toContain('brave-search/skills');
    vi.restoreAllMocks();
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
