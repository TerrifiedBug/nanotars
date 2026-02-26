import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../config.js', () => ({
  DATA_DIR: '/tmp/__replaced__',
  GROUPS_DIR: '/tmp/__replaced__',
}));

vi.mock('../mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import * as configMod from '../config.js';
import { validateAdditionalMounts } from '../mount-security.js';
import type { RegisteredGroup } from '../types.js';

let tmpDir: string;
let projectRoot: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Main',
    folder: 'main',
    trigger: '@TARS',
    added_at: '2024-01-01',
    channel: 'whatsapp',
    ...overrides,
  };
}

function setupProjectDirs(): void {
  // Minimal project structure
  fs.mkdirSync(path.join(projectRoot, 'container', 'agent-runner', 'src'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'container', 'skills', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'container', 'skills', 'ipc'), { recursive: true });
}

function setupGroupDirs(folder: string): void {
  const groupsDir = (configMod as any).GROUPS_DIR;
  fs.mkdirSync(path.join(groupsDir, folder), { recursive: true });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cmounts-'));
  projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });

  const dataDir = path.join(tmpDir, 'data');
  const groupsDir = path.join(tmpDir, 'groups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(groupsDir, { recursive: true });

  (configMod as any).DATA_DIR = dataDir;
  (configMod as any).GROUPS_DIR = groupsDir;
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
  vi.clearAllMocks();
});

afterEach(() => {
  cwdSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Core mount tests ---

describe('buildVolumeMounts: core mounts', () => {
  let buildVolumeMounts: typeof import('../container-mounts.js').buildVolumeMounts;
  let setPluginRegistry: typeof import('../container-mounts.js').setPluginRegistry;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../container-mounts.js');
    buildVolumeMounts = mod.buildVolumeMounts;
    setPluginRegistry = mod.setPluginRegistry;
  });

  it('mounts agent-runner source', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const mounts = await buildVolumeMounts(makeGroup(), true);
    const agentRunner = mounts.find(m => m.containerPath === '/app/src');
    expect(agentRunner).toBeDefined();
    expect(agentRunner!.readonly).toBe(true);
    expect(agentRunner!.hostPath).toContain('agent-runner');
  });

  it('mounts core skill subdirectories individually', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const mounts = await buildVolumeMounts(makeGroup(), true);
    const skillMounts = mounts.filter(m => m.containerPath.startsWith('/workspace/.claude/skills/'));
    expect(skillMounts.length).toBeGreaterThanOrEqual(2);
    expect(skillMounts.some(m => m.containerPath.includes('memory'))).toBe(true);
    expect(skillMounts.some(m => m.containerPath.includes('ipc'))).toBe(true);
    skillMounts.forEach(m => expect(m.readonly).toBe(true));
  });

  it('creates per-group sessions directory', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    await buildVolumeMounts(makeGroup(), true);
    const sessionsDir = path.join((configMod as any).DATA_DIR, 'sessions', 'main', '.claude');
    expect(fs.existsSync(sessionsDir)).toBe(true);
  });

  it('mounts sessions directory at /home/node/.claude', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const mounts = await buildVolumeMounts(makeGroup(), true);
    const sessions = mounts.find(m => m.containerPath === '/home/node/.claude');
    expect(sessions).toBeDefined();
    expect(sessions!.readonly).toBe(false);
  });

  it('creates IPC directories (messages, tasks, input)', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    await buildVolumeMounts(makeGroup(), true);
    const ipcDir = path.join((configMod as any).DATA_DIR, 'ipc', 'main');
    expect(fs.existsSync(path.join(ipcDir, 'messages'))).toBe(true);
    expect(fs.existsSync(path.join(ipcDir, 'tasks'))).toBe(true);
    expect(fs.existsSync(path.join(ipcDir, 'input'))).toBe(true);
  });

  it('mounts IPC at /workspace/ipc', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const mounts = await buildVolumeMounts(makeGroup(), true);
    const ipc = mounts.find(m => m.containerPath === '/workspace/ipc');
    expect(ipc).toBeDefined();
    expect(ipc!.readonly).toBe(false);
  });

  it('mounts group folder at /workspace/group', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const mounts = await buildVolumeMounts(makeGroup(), true);
    const group = mounts.find(m => m.containerPath === '/workspace/group');
    expect(group).toBeDefined();
    expect(group!.readonly).toBe(false);
  });

  it('mounts global directory when it exists', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    fs.mkdirSync(path.join((configMod as any).GROUPS_DIR, 'global'), { recursive: true });
    const mounts = await buildVolumeMounts(makeGroup(), true);
    const globalMount = mounts.find(m => m.containerPath === '/workspace/global');
    expect(globalMount).toBeDefined();
    expect(globalMount!.readonly).toBe(true);
  });

  it('does not mount global directory when it does not exist', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const mounts = await buildVolumeMounts(makeGroup(), true);
    const globalMount = mounts.find(m => m.containerPath === '/workspace/global');
    expect(globalMount).toBeUndefined();
  });
});

// --- Main vs non-main ---

describe('buildVolumeMounts: main vs non-main', () => {
  let buildVolumeMounts: typeof import('../container-mounts.js').buildVolumeMounts;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../container-mounts.js');
    buildVolumeMounts = mod.buildVolumeMounts;
  });

  it('main gets project root mounted at /workspace/project', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const mounts = await buildVolumeMounts(makeGroup(), true);
    const project = mounts.find(m => m.containerPath === '/workspace/project');
    expect(project).toBeDefined();
    expect(project!.readonly).toBe(true);
  });

  it('non-main does NOT get project root', async () => {
    setupProjectDirs();
    setupGroupDirs('family');
    const mounts = await buildVolumeMounts(makeGroup({ folder: 'family', name: 'Family' }), false);
    const project = mounts.find(m => m.containerPath === '/workspace/project');
    expect(project).toBeUndefined();
  });

  it('non-main only gets its own group folder', async () => {
    setupProjectDirs();
    setupGroupDirs('family');
    const mounts = await buildVolumeMounts(makeGroup({ folder: 'family', name: 'Family' }), false);
    const group = mounts.find(m => m.containerPath === '/workspace/group');
    expect(group).toBeDefined();
    expect(group!.hostPath).toContain('family');
  });
});

// --- assertPathWithin (path traversal) ---

describe('buildVolumeMounts: path traversal protection', () => {
  let buildVolumeMounts: typeof import('../container-mounts.js').buildVolumeMounts;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../container-mounts.js');
    buildVolumeMounts = mod.buildVolumeMounts;
  });

  it('throws on group folder path traversal', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    await expect(
      buildVolumeMounts(makeGroup({ folder: '../escape' }), false),
    ).rejects.toThrow('Path traversal blocked');
  });
});

// --- Plugin skill and hook mounts ---

describe('buildVolumeMounts: plugin integration', () => {
  let buildVolumeMounts: typeof import('../container-mounts.js').buildVolumeMounts;
  let setPluginRegistry: typeof import('../container-mounts.js').setPluginRegistry;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../container-mounts.js');
    buildVolumeMounts = mod.buildVolumeMounts;
    setPluginRegistry = mod.setPluginRegistry;
  });

  it('mounts plugin skill directories', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const skillDir = path.join(tmpDir, 'plugin-skills');
    fs.mkdirSync(skillDir, { recursive: true });

    setPluginRegistry({
      getSkillPaths: vi.fn(() => [{ name: 'test-skill', hostPath: skillDir }]),
      getContainerHookPaths: vi.fn(() => []),
      getContainerMounts: vi.fn(() => []),
      getMergedMcpConfig: vi.fn(() => ({ mcpServers: {} })),
      getContainerEnvVars: vi.fn(() => ['ANTHROPIC_API_KEY']),
    } as any);

    const mounts = await buildVolumeMounts(makeGroup(), true);
    const pluginSkill = mounts.find(m => m.containerPath === '/workspace/.claude/skills/test-skill');
    expect(pluginSkill).toBeDefined();
    expect(pluginSkill!.readonly).toBe(true);
  });

  it('mounts plugin container hooks', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const hookFile = path.join(tmpDir, 'plugin-hook.js');
    fs.writeFileSync(hookFile, '// hook');

    setPluginRegistry({
      getSkillPaths: vi.fn(() => []),
      getContainerHookPaths: vi.fn(() => [{ name: 'test-hook.js', hostPath: hookFile }]),
      getContainerMounts: vi.fn(() => []),
      getMergedMcpConfig: vi.fn(() => ({ mcpServers: {} })),
      getContainerEnvVars: vi.fn(() => ['ANTHROPIC_API_KEY']),
    } as any);

    const mounts = await buildVolumeMounts(makeGroup(), true);
    const hookMount = mounts.find(m => m.containerPath === '/workspace/plugin-hooks/test-hook.js');
    expect(hookMount).toBeDefined();
    expect(hookMount!.readonly).toBe(true);
  });

  it('mounts merged MCP config when plugins provide servers', async () => {
    setupProjectDirs();
    setupGroupDirs('main');

    setPluginRegistry({
      getSkillPaths: vi.fn(() => []),
      getContainerHookPaths: vi.fn(() => []),
      getContainerMounts: vi.fn(() => []),
      getMergedMcpConfig: vi.fn(() => ({ mcpServers: { 'test-server': { command: 'node' } } })),
      getContainerEnvVars: vi.fn(() => ['ANTHROPIC_API_KEY']),
    } as any);

    const mounts = await buildVolumeMounts(makeGroup(), true);
    const mcpMount = mounts.find(m => m.containerPath === '/workspace/.mcp.json');
    expect(mcpMount).toBeDefined();
    expect(mcpMount!.readonly).toBe(true);
  });

  it('validates plugin container mounts against allowlist', async () => {
    setupProjectDirs();
    setupGroupDirs('main');

    vi.mocked(validateAdditionalMounts).mockReturnValue([
      { hostPath: '/some/path', containerPath: '/workspace/extra/data', readonly: true },
    ]);

    setPluginRegistry({
      getSkillPaths: vi.fn(() => []),
      getContainerHookPaths: vi.fn(() => []),
      getContainerMounts: vi.fn(() => [{ hostPath: '/some/path', containerPath: '/workspace/extra/data' }]),
      getMergedMcpConfig: vi.fn(() => ({ mcpServers: {} })),
      getContainerEnvVars: vi.fn(() => ['ANTHROPIC_API_KEY']),
    } as any);

    const mounts = await buildVolumeMounts(makeGroup(), true);

    expect(validateAdditionalMounts).toHaveBeenCalledWith(
      [{ hostPath: '/some/path', containerPath: '/workspace/extra/data', readonly: true }],
      'Main',
      true,
    );

    const extra = mounts.find(m => m.containerPath === '/workspace/extra/data');
    expect(extra).toBeDefined();
    expect(extra!.readonly).toBe(true);
  });

  it('filters out rejected plugin container mounts', async () => {
    setupProjectDirs();
    setupGroupDirs('main');

    setPluginRegistry({
      getSkillPaths: vi.fn(() => []),
      getContainerHookPaths: vi.fn(() => []),
      getContainerMounts: vi.fn(() => [
        { hostPath: '/blocked/path', containerPath: '/workspace/extra/blocked' },
      ]),
      getMergedMcpConfig: vi.fn(() => ({ mcpServers: {} })),
      getContainerEnvVars: vi.fn(() => ['ANTHROPIC_API_KEY']),
    } as any);

    vi.mocked(validateAdditionalMounts).mockReturnValue([]);

    const mounts = await buildVolumeMounts(makeGroup(), true);
    const blocked = mounts.find(m => m.containerPath === '/workspace/extra/blocked');
    expect(blocked).toBeUndefined();
  });

  it('mounts root .mcp.json directly when no plugin registry', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    fs.writeFileSync(path.join(projectRoot, '.mcp.json'), '{"mcpServers":{}}');

    // No setPluginRegistry call — registry remains null
    const mounts = await buildVolumeMounts(makeGroup(), true);
    const mcpMount = mounts.find(m => m.containerPath === '/workspace/.mcp.json');
    expect(mcpMount).toBeDefined();
    expect(mcpMount!.hostPath).toContain('.mcp.json');
  });
});

// --- Env file construction ---

describe('buildVolumeMounts: env file', () => {
  let buildVolumeMounts: typeof import('../container-mounts.js').buildVolumeMounts;
  let setPluginRegistry: typeof import('../container-mounts.js').setPluginRegistry;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../container-mounts.js');
    buildVolumeMounts = mod.buildVolumeMounts;
    setPluginRegistry = mod.setPluginRegistry;
  });

  it('filters env vars to allowed list', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    fs.writeFileSync(path.join(projectRoot, '.env'), 'ANTHROPIC_API_KEY=sk-test\nSECRET=hidden\nCLAUDE_MODEL=sonnet');

    setPluginRegistry({
      getSkillPaths: vi.fn(() => []),
      getContainerHookPaths: vi.fn(() => []),
      getContainerMounts: vi.fn(() => []),
      getMergedMcpConfig: vi.fn(() => ({ mcpServers: {} })),
      getContainerEnvVars: vi.fn(() => ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL']),
    } as any);

    await buildVolumeMounts(makeGroup(), true);
    const envFilePath = path.join((configMod as any).DATA_DIR, 'env', 'main', 'env');
    expect(fs.existsSync(envFilePath)).toBe(true);
    const content = fs.readFileSync(envFilePath, 'utf-8');
    expect(content).toContain('ANTHROPIC_API_KEY');
    expect(content).toContain('CLAUDE_MODEL');
    expect(content).not.toContain('SECRET=hidden');
  });

  it('overrides CLAUDE_MODEL from store file', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    fs.writeFileSync(path.join(projectRoot, '.env'), 'CLAUDE_MODEL=sonnet\nANTHROPIC_API_KEY=sk-x');
    const storeDir = path.join(projectRoot, 'store');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'claude-model'), 'opus');

    setPluginRegistry({
      getSkillPaths: vi.fn(() => []),
      getContainerHookPaths: vi.fn(() => []),
      getContainerMounts: vi.fn(() => []),
      getMergedMcpConfig: vi.fn(() => ({ mcpServers: {} })),
      getContainerEnvVars: vi.fn(() => ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL']),
    } as any);

    await buildVolumeMounts(makeGroup(), true);
    const content = fs.readFileSync(path.join((configMod as any).DATA_DIR, 'env', 'main', 'env'), 'utf-8');
    expect(content).toContain("CLAUDE_MODEL='opus'");
  });

  it('per-task model override takes highest priority', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    fs.writeFileSync(path.join(projectRoot, '.env'), 'CLAUDE_MODEL=sonnet\nANTHROPIC_API_KEY=sk-x');
    const storeDir = path.join(projectRoot, 'store');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'claude-model'), 'opus');

    setPluginRegistry({
      getSkillPaths: vi.fn(() => []),
      getContainerHookPaths: vi.fn(() => []),
      getContainerMounts: vi.fn(() => []),
      getMergedMcpConfig: vi.fn(() => ({ mcpServers: {} })),
      getContainerEnvVars: vi.fn(() => ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL']),
    } as any);

    await buildVolumeMounts(makeGroup(), true, 'haiku');
    const content = fs.readFileSync(path.join((configMod as any).DATA_DIR, 'env', 'main', 'env'), 'utf-8');
    expect(content).toContain("CLAUDE_MODEL='haiku'");
  });

  it('shell-safe quotes env values', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    fs.writeFileSync(path.join(projectRoot, '.env'), "ANTHROPIC_API_KEY=sk-with'quote");

    setPluginRegistry({
      getSkillPaths: vi.fn(() => []),
      getContainerHookPaths: vi.fn(() => []),
      getContainerMounts: vi.fn(() => []),
      getMergedMcpConfig: vi.fn(() => ({ mcpServers: {} })),
      getContainerEnvVars: vi.fn(() => ['ANTHROPIC_API_KEY']),
    } as any);

    await buildVolumeMounts(makeGroup(), true);
    const content = fs.readFileSync(path.join((configMod as any).DATA_DIR, 'env', 'main', 'env'), 'utf-8');
    // Single quotes escaped with '\''
    expect(content).toContain("ANTHROPIC_API_KEY='sk-with'\\''quote'");
  });

  it('skips env mount when no matching vars', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    fs.writeFileSync(path.join(projectRoot, '.env'), 'UNRELATED=value');

    setPluginRegistry({
      getSkillPaths: vi.fn(() => []),
      getContainerHookPaths: vi.fn(() => []),
      getContainerMounts: vi.fn(() => []),
      getMergedMcpConfig: vi.fn(() => ({ mcpServers: {} })),
      getContainerEnvVars: vi.fn(() => ['ANTHROPIC_API_KEY']),
    } as any);

    const mounts = await buildVolumeMounts(makeGroup(), true);
    const envMount = mounts.find(m => m.containerPath === '/workspace/env-dir');
    expect(envMount).toBeUndefined();
  });

  it('re-reads .env when file mtime changes', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const envPath = path.join(projectRoot, '.env');

    // Write initial .env with original key
    fs.writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-original');

    setPluginRegistry({
      getSkillPaths: vi.fn(() => []),
      getContainerHookPaths: vi.fn(() => []),
      getContainerMounts: vi.fn(() => []),
      getMergedMcpConfig: vi.fn(() => ({ mcpServers: {} })),
      getContainerEnvVars: vi.fn(() => ['ANTHROPIC_API_KEY']),
    } as any);

    // First call — caches the .env
    await buildVolumeMounts(makeGroup(), true);
    const envFilePath = path.join((configMod as any).DATA_DIR, 'env', 'main', 'env');
    const content1 = fs.readFileSync(envFilePath, 'utf-8');
    expect(content1).toContain('sk-original');

    // Update .env content and bump mtime to ensure it differs
    fs.writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-updated');
    const currentStat = fs.statSync(envPath);
    fs.utimesSync(envPath, currentStat.atime, new Date(currentStat.mtimeMs + 2000));

    // Second call — should detect mtime change and re-read
    await buildVolumeMounts(makeGroup(), true);
    const content2 = fs.readFileSync(envFilePath, 'utf-8');
    expect(content2).toContain('sk-updated');
    expect(content2).not.toContain('sk-original');
  });
});

// --- Additional mounts passthrough ---

describe('buildVolumeMounts: additional mounts', () => {
  let buildVolumeMounts: typeof import('../container-mounts.js').buildVolumeMounts;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../container-mounts.js');
    buildVolumeMounts = mod.buildVolumeMounts;
  });

  it('passes additional mounts to validateAdditionalMounts', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const addlMounts = [{ hostPath: '/home/user/data', containerPath: 'data' }];

    vi.mocked(validateAdditionalMounts).mockReturnValue([
      { hostPath: '/home/user/data', containerPath: '/workspace/extra/data', readonly: true },
    ]);

    const mounts = await buildVolumeMounts(
      makeGroup({ containerConfig: { additionalMounts: addlMounts } }),
      true,
    );
    expect(validateAdditionalMounts).toHaveBeenCalledWith(addlMounts, 'Main', true);
    const extra = mounts.find(m => m.containerPath === '/workspace/extra/data');
    expect(extra).toBeDefined();
  });

  it('skips additional mounts when not configured', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    await buildVolumeMounts(makeGroup(), true);
    expect(validateAdditionalMounts).not.toHaveBeenCalled();
  });
});

// --- Credentials mount ---

describe('buildVolumeMounts: credentials', () => {
  let buildVolumeMounts: typeof import('../container-mounts.js').buildVolumeMounts;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../container-mounts.js');
    buildVolumeMounts = mod.buildVolumeMounts;
  });

  it('mounts host credentials when file exists', async () => {
    setupProjectDirs();
    setupGroupDirs('main');
    const homeDir = os.homedir();
    const credsFile = path.join(homeDir, '.claude', '.credentials.json');
    // Only test if credentials file actually exists on this system
    if (fs.existsSync(credsFile)) {
      const mounts = await buildVolumeMounts(makeGroup(), true);
      const creds = mounts.find(m => m.containerPath === '/home/node/.claude/.credentials.json');
      expect(creds).toBeDefined();
      expect(creds!.readonly).toBe(false);
    }
  });
});

// --- readSecrets ---

describe('readSecrets', () => {
  it('delegates to readEnvFile for auth keys', async () => {
    vi.resetModules();
    const { readEnvFile } = await import('../env.js');
    vi.mocked(readEnvFile).mockReturnValue({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key' });
    const { readSecrets } = await import('../container-mounts.js');
    const secrets = readSecrets();
    expect(readEnvFile).toHaveBeenCalledWith(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    expect(secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key' });
  });
});
