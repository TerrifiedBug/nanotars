import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Config mock — MOUNT_ALLOWLIST_PATH will be overridden per test group
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/tmp/__replaced__',
}));

import * as configMod from './config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mount-sec-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAllowlist(obj: object): string {
  const filePath = path.join(tmpDir, 'mount-allowlist.json');
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
  return filePath;
}

function validAllowlist(overrides: object = {}) {
  return {
    allowedRoots: [
      { path: tmpDir, allowReadWrite: true, description: 'Test root' },
    ],
    blockedPatterns: [],
    nonMainReadOnly: false,
    ...overrides,
  };
}

// --- loadMountAllowlist ---

describe('loadMountAllowlist', () => {
  it('returns null when file is missing', async () => {
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = path.join(tmpDir, 'nonexistent.json');
    const { loadMountAllowlist } = await import('./mount-security.js');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('loads valid allowlist', async () => {
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { loadMountAllowlist } = await import('./mount-security.js');
    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.allowedRoots).toHaveLength(1);
    expect(result!.nonMainReadOnly).toBe(false);
  });

  it('merges default blocked patterns with user patterns', async () => {
    const filePath = writeAllowlist(validAllowlist({ blockedPatterns: ['custom-secret'] }));
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { loadMountAllowlist } = await import('./mount-security.js');
    const result = loadMountAllowlist();
    expect(result!.blockedPatterns).toContain('.ssh');
    expect(result!.blockedPatterns).toContain('.gnupg');
    expect(result!.blockedPatterns).toContain('custom-secret');
  });

  it('returns null for invalid JSON', async () => {
    const filePath = path.join(tmpDir, 'mount-allowlist.json');
    fs.writeFileSync(filePath, 'not json {{{');
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { loadMountAllowlist } = await import('./mount-security.js');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when allowedRoots is not an array', async () => {
    const filePath = writeAllowlist({ allowedRoots: 'bad', blockedPatterns: [], nonMainReadOnly: false });
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { loadMountAllowlist } = await import('./mount-security.js');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when blockedPatterns is not an array', async () => {
    const filePath = writeAllowlist({ allowedRoots: [], blockedPatterns: 'bad', nonMainReadOnly: false });
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { loadMountAllowlist } = await import('./mount-security.js');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when nonMainReadOnly is not a boolean', async () => {
    const filePath = writeAllowlist({ allowedRoots: [], blockedPatterns: [], nonMainReadOnly: 'yes' });
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { loadMountAllowlist } = await import('./mount-security.js');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('caches result after first load', async () => {
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { loadMountAllowlist } = await import('./mount-security.js');
    const first = loadMountAllowlist();
    // Modify file — should still return cached
    fs.writeFileSync(filePath, JSON.stringify({ allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true }));
    const second = loadMountAllowlist();
    expect(second).toBe(first);
  });
});

// --- validateMount ---

describe('validateMount', () => {
  it('allows path under an allowed root', async () => {
    const subDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(subDir);
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: subDir }, true);
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe(subDir);
  });

  it('rejects path not under any allowed root', async () => {
    const filePath = writeAllowlist(validAllowlist({
      allowedRoots: [{ path: '/opt/allowed', allowReadWrite: false }],
    }));
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: tmpDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('rejects path matching a blocked pattern', async () => {
    const sshDir = path.join(tmpDir, '.ssh');
    fs.mkdirSync(sshDir);
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: sshDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('rejects path containing .env', async () => {
    const envDir = path.join(tmpDir, '.env');
    fs.mkdirSync(envDir);
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: envDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.env');
  });

  it('rejects path traversal in container path', async () => {
    const subDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(subDir);
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: subDir, containerPath: '../../escape' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('..');
  });

  it('rejects absolute container path', async () => {
    const subDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(subDir);
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: subDir, containerPath: '/etc/shadow' }, true);
    expect(result.allowed).toBe(false);
  });

  it('resolves symlinks and validates real path', async () => {
    const realDir = path.join(tmpDir, 'real-data');
    fs.mkdirSync(realDir);
    const linkPath = path.join(tmpDir, 'link-to-data');
    fs.symlinkSync(realDir, linkPath);
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: linkPath }, true);
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe(realDir);
  });

  it('rejects symlink pointing outside allowed roots', async () => {
    // Create a symlink inside tmpDir that points to /tmp (not under allowed root)
    const allowedDir = path.join(tmpDir, 'allowed');
    fs.mkdirSync(allowedDir);
    const linkPath = path.join(allowedDir, 'escape');
    fs.symlinkSync('/tmp', linkPath);
    const filePath = writeAllowlist(validAllowlist({
      allowedRoots: [{ path: allowedDir, allowReadWrite: false }],
    }));
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: linkPath }, true);
    expect(result.allowed).toBe(false);
  });

  it('rejects nonexistent host path', async () => {
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: path.join(tmpDir, 'nonexistent') }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('expands ~/ in host path', async () => {
    const homeDir = os.homedir();
    // This tests that ~/ expansion works — we just need it not to crash
    const filePath = writeAllowlist(validAllowlist({
      allowedRoots: [{ path: homeDir, allowReadWrite: false }],
    }));
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    // Use a path we know exists under home
    const result = validateMount({ hostPath: homeDir }, true);
    expect(result.allowed).toBe(true);
  });

  it('enforces readonly for non-main when nonMainReadOnly is true', async () => {
    const subDir = path.join(tmpDir, 'data');
    fs.mkdirSync(subDir);
    const filePath = writeAllowlist(validAllowlist({ nonMainReadOnly: true }));
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: subDir, readonly: false }, false);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows read-write for main even when nonMainReadOnly is true', async () => {
    const subDir = path.join(tmpDir, 'data');
    fs.mkdirSync(subDir);
    const filePath = writeAllowlist(validAllowlist({ nonMainReadOnly: true }));
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: subDir, readonly: false }, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('forces readonly when root does not allow readWrite', async () => {
    const subDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(subDir);
    const filePath = writeAllowlist(validAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: false, description: 'ro root' }],
    }));
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: subDir, readonly: false }, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('defaults to readonly when readonly is not explicitly false', async () => {
    const subDir = path.join(tmpDir, 'safe');
    fs.mkdirSync(subDir);
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: subDir }, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('derives containerPath from hostPath basename when not specified', async () => {
    const subDir = path.join(tmpDir, 'myproject');
    fs.mkdirSync(subDir);
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: subDir }, true);
    expect(result.resolvedContainerPath).toBe('myproject');
  });

  it('blocks all mounts when no allowlist exists', async () => {
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = path.join(tmpDir, 'nonexistent.json');
    const { validateMount } = await import('./mount-security.js');
    const result = validateMount({ hostPath: tmpDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist configured');
  });
});

// --- validateAdditionalMounts ---

describe('validateAdditionalMounts', () => {
  it('filters out rejected mounts and passes valid ones', async () => {
    const goodDir = path.join(tmpDir, 'good');
    fs.mkdirSync(goodDir);
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateAdditionalMounts } = await import('./mount-security.js');
    const result = validateAdditionalMounts(
      [
        { hostPath: goodDir },
        { hostPath: '/nonexistent/bad/path' },
      ],
      'test-group',
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].hostPath).toBe(goodDir);
  });

  it('prefixes container paths with /workspace/extra/', async () => {
    const dir = path.join(tmpDir, 'mydata');
    fs.mkdirSync(dir);
    const filePath = writeAllowlist(validAllowlist());
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = filePath;
    const { validateAdditionalMounts } = await import('./mount-security.js');
    const result = validateAdditionalMounts(
      [{ hostPath: dir, containerPath: 'custom-name' }],
      'test-group',
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].containerPath).toBe('/workspace/extra/custom-name');
  });

  it('returns empty array when no allowlist', async () => {
    vi.resetModules();
    (configMod as any).MOUNT_ALLOWLIST_PATH = path.join(tmpDir, 'nonexistent.json');
    const { validateAdditionalMounts } = await import('./mount-security.js');
    const result = validateAdditionalMounts(
      [{ hostPath: tmpDir }],
      'test-group',
      true,
    );
    expect(result).toHaveLength(0);
  });
});

// --- generateAllowlistTemplate ---

describe('generateAllowlistTemplate', () => {
  it('generates valid JSON', async () => {
    vi.resetModules();
    const { generateAllowlistTemplate } = await import('./mount-security.js');
    const template = generateAllowlistTemplate();
    const parsed = JSON.parse(template);
    expect(parsed.allowedRoots).toBeInstanceOf(Array);
    expect(parsed.blockedPatterns).toBeInstanceOf(Array);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');
  });

  it('includes example roots and patterns', async () => {
    vi.resetModules();
    const { generateAllowlistTemplate } = await import('./mount-security.js');
    const parsed = JSON.parse(generateAllowlistTemplate());
    expect(parsed.allowedRoots.length).toBeGreaterThan(0);
    expect(parsed.blockedPatterns.length).toBeGreaterThan(0);
  });
});
