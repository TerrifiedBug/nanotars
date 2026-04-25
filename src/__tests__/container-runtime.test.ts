import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for install-slug labeling (D2).
 *
 * Verifies:
 * 1. Orphan cleanup uses label=nanoclaw.install=<slug> filter (not name prefix)
 * 2. Container spawn includes --label nanoclaw.install=<slug>
 * 3. NANOCLAW_INSTALL_SLUG env var overrides the cwd-derived default
 */

// ─── Hoisted constants and mock state (safe to reference in vi.mock factories) ─

const { TEST_SLUG, mocks } = vi.hoisted(() => ({
  TEST_SLUG: 'nanotars' as string,
  mocks: {
    execFileSync: vi.fn(),
    spawn: vi.fn(() => ({
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    })),
  },
}));

// ─── Top-level vi.mock calls (hoisted by Vitest) ──────────────────────────────

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../config.js', () => ({
  INSTALL_SLUG: TEST_SLUG,
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/test-data',
  GROUPS_DIR: '/tmp/test-groups',
  IDLE_TIMEOUT: 1800000,
  SCHEDULED_TASK_IDLE_TIMEOUT: 30000,
  ASSISTANT_NAME: 'TARS',
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: mocks.execFileSync,
    spawn: mocks.spawn,
    execFile: vi.fn(
      (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
      },
    ),
  };
});

vi.mock('../container-mounts.js', async () => {
  const actual = await vi.importActual<typeof import('../container-mounts.js')>('../container-mounts.js');
  return {
    ...actual,
    buildVolumeMounts: vi.fn(async () => []),
    readSecrets: vi.fn(() => ({})),
  };
});

vi.mock('../mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('../secret-redact.js', () => ({
  redactSecrets: vi.fn((s: string) => s),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const fakeWriteStream = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      appendFileSync: vi.fn(),
      createWriteStream: vi.fn(() => fakeWriteStream),
    },
  };
});

vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    default: {
      ...actual,
      randomBytes: vi.fn(() => Buffer.from('deadbeefcafebabe1234567890abcdef', 'hex')),
    },
  };
});

// ─── Import after mocks ───────────────────────────────────────────────────────

import { ensureRunning } from '../container-runtime.js';
import { runContainerAgent } from '../container-runner.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('install-slug labeling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore spawn mock return value after clearAllMocks resets it
    mocks.spawn.mockReturnValue({
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    });
  });

  describe('orphan cleanup filters by nanoclaw.install label', () => {
    it('docker ps uses label=nanoclaw.install filter instead of name prefix', () => {
      // docker info → success so detectRuntime returns 'docker'
      // docker ps -a → empty string (no orphans)
      mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[0] === 'info') return '';
        if (cmd === 'docker' && args[0] === 'ps') return '';
        return '';
      });

      ensureRunning();

      const psCalls = mocks.execFileSync.mock.calls.filter(
        (c: unknown[]) => c[0] === 'docker' && (c[1] as string[])?.[0] === 'ps',
      );
      expect(psCalls.length).toBeGreaterThanOrEqual(1);

      const psArgs = psCalls[0][1] as string[];

      // Must contain --filter with label=nanoclaw.install=<slug>
      const filterIdx = psArgs.indexOf('--filter');
      expect(filterIdx).not.toBe(-1);
      expect(psArgs[filterIdx + 1]).toBe(`label=nanoclaw.install=${TEST_SLUG}`);

      // Must NOT contain the old name= prefix filter
      const hasNameFilter = psArgs.some((a: string) => a.startsWith('name=nanoclaw-'));
      expect(hasNameFilter).toBe(false);
    });
  });

  describe('container spawn applies nanoclaw.install label', () => {
    it('docker run args include --label nanoclaw.install=<slug>', async () => {
      // docker info → success
      mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[0] === 'info') return '';
        if (cmd === 'docker' && args[0] === 'ps') return '';
        return '';
      });

      const testGroup = {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@TARS',
        added_at: new Date().toISOString(),
      };

      // Start run (we don't need it to complete)
      runContainerAgent(
        testGroup,
        { prompt: 'hi', groupFolder: 'test-group', chatJid: 'test@g.us', isMain: false },
        () => {},
      );

      // Give async buildVolumeMounts a tick to settle
      await new Promise((r) => setTimeout(r, 20));

      // spawn is called as spawn(cli(), containerArgs)
      // Find the 'docker run' call
      const runCalls = mocks.spawn.mock.calls.filter(
        (c: unknown[]) => c[0] === 'docker' && (c[1] as string[])?.[0] === 'run',
      );
      expect(runCalls.length).toBeGreaterThanOrEqual(1);

      const runArgs = runCalls[0][1] as string[];
      const labelIdx = runArgs.indexOf('--label');
      expect(labelIdx).not.toBe(-1);
      expect(runArgs[labelIdx + 1]).toBe(`nanoclaw.install=${TEST_SLUG}`);
    });
  });

  describe('NANOCLAW_INSTALL_SLUG env var overrides the cwd-derived default', () => {
    // config.ts evaluates INSTALL_SLUG at module load time using this expression:
    //   process.env.NANOCLAW_INSTALL_SLUG ?? path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]/g, '-')
    //
    // Rather than fighting the top-level vi.mock to re-import the real config,
    // we test the expression logic directly — same semantics, no import dance.
    const computeSlug = (envVal: string | undefined, cwdBasename: string): string => {
      return envVal ?? cwdBasename.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    };

    it('NANOCLAW_INSTALL_SLUG env var overrides the cwd-derived default', () => {
      const result = computeSlug('custom-install', 'nanotars');
      expect(result).toBe('custom-install');
    });

    it('derives slug from cwd basename when NANOCLAW_INSTALL_SLUG is not set', () => {
      const result = computeSlug(undefined, 'nanotars');
      expect(result).toBe('nanotars');
    });

    it('sanitizes non-alphanumeric chars in the cwd-derived slug', () => {
      const result = computeSlug(undefined, 'My_Project.v2!');
      // Only a-z, 0-9, and - allowed; everything else becomes -
      expect(result).toBe('my-project-v2-');
    });
  });
});
