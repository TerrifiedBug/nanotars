import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Fixed nonce for tests (crypto.randomBytes is mocked below)
const TEST_NONCE = 'deadbeefcafebabe1234567890abcdef';
const OUTPUT_START_MARKER = `---NANOCLAW_OUTPUT_${TEST_NONCE}_START---`;
const OUTPUT_END_MARKER = `---NANOCLAW_OUTPUT_${TEST_NONCE}_END---`;

// Mock config
vi.mock('../config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  INSTALL_SLUG: 'nanoclaw-test',
  ONECLI_URL: 'http://127.0.0.1:10254',
  ONECLI_API_KEY: '',
}));

// Default mock for @onecli-sh/sdk — individual tests can override via vi.doMock
// before re-importing the module.
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = vi.fn().mockResolvedValue(undefined);
    applyContainerConfig = vi.fn().mockResolvedValue(false);
    configureManualApproval = vi.fn();
  },
}));

// Mock crypto to return a fixed nonce
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    default: {
      ...actual,
      randomBytes: vi.fn(() => Buffer.from(TEST_NONCE, 'hex')),
    },
  };
});

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  // Fake writable stream that accepts writes silently
  const fakeWriteStream = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      appendFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      createWriteStream: vi.fn(() => fakeWriteStream),
    },
  };
});

// Mock mount-security
vi.mock('../mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-mounts: buildVolumeMounts is now async
vi.mock('../container-mounts.js', async () => {
  const actual = await vi.importActual<typeof import('../container-mounts.js')>('../container-mounts.js');
  return {
    ...actual,
    buildVolumeMounts: vi.fn(async () => []),
    readSecrets: vi.fn(() => ({})),
  };
});

// Mock container-runtime: fixMountPermissions is async and must resolve immediately in tests
vi.mock('../container-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../container-runtime.js')>('../container-runtime.js');
  return {
    ...actual,
    fixMountPermissions: vi.fn(() => Promise.resolve()),
  };
});

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    }),
  };
});

import { runContainerAgent, ContainerOutput } from '../container-runner.js';
import type { AgentGroup } from '../types.js';

const testGroup: AgentGroup = {
  id: 'ag-test',
  name: 'Test Group',
  folder: 'test-group',
  agent_provider: null,
  container_config: null,
  created_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('buildContainerArgs OneCLI integration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@onecli-sh/sdk');
  });

  it('calls ensureAgent + applyContainerConfig when identifier is provided', async () => {
    const ensureAgent = vi.fn().mockResolvedValue(undefined);
    const applyContainerConfig = vi.fn().mockImplementation(async (args: string[]) => {
      args.push('-e', 'HTTPS_PROXY=http://onecli.test', '-v', '/tmp/ca.pem:/etc/ssl/certs/onecli.pem:ro');
      return true;
    });
    vi.doMock('@onecli-sh/sdk', () => ({
      OneCLI: class {
        ensureAgent = ensureAgent;
        applyContainerConfig = applyContainerConfig;
      },
    }));
    // Re-mock config because vi.resetModules clears module-scoped mocks too.
    vi.doMock('../config.js', () => ({
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      CONTAINER_MAX_OUTPUT_SIZE: 10485760,
      CONTAINER_TIMEOUT: 1800000,
      DATA_DIR: '/tmp/nanoclaw-test-data',
      GROUPS_DIR: '/tmp/nanoclaw-test-groups',
      IDLE_TIMEOUT: 1800000,
      INSTALL_SLUG: 'nanoclaw-test',
      ONECLI_URL: 'http://127.0.0.1:10254',
      ONECLI_API_KEY: '',
    }));
    vi.doMock('../logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting([], 'nc-test', 'main');

    expect(ensureAgent).toHaveBeenCalledWith({ name: 'main', identifier: 'main' });
    expect(applyContainerConfig).toHaveBeenCalledWith(args, expect.objectContaining({ agent: 'main' }));
    expect(args.some(a => typeof a === 'string' && a.includes('HTTPS_PROXY=http://onecli.test'))).toBe(true);
  });

  it('continues without OneCLI when applyContainerConfig returns false', async () => {
    const ensureAgent = vi.fn().mockResolvedValue(undefined);
    const applyContainerConfig = vi.fn().mockResolvedValue(false);
    vi.doMock('@onecli-sh/sdk', () => ({
      OneCLI: class {
        ensureAgent = ensureAgent;
        applyContainerConfig = applyContainerConfig;
      },
    }));
    vi.doMock('../config.js', () => ({
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      CONTAINER_MAX_OUTPUT_SIZE: 10485760,
      CONTAINER_TIMEOUT: 1800000,
      DATA_DIR: '/tmp/nanoclaw-test-data',
      GROUPS_DIR: '/tmp/nanoclaw-test-groups',
      IDLE_TIMEOUT: 1800000,
      INSTALL_SLUG: 'nanoclaw-test',
      ONECLI_URL: 'http://127.0.0.1:10254',
      ONECLI_API_KEY: '',
    }));
    vi.doMock('../logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting([], 'nc-test', 'main');

    expect(args).toContain('--rm');
    expect(args.find(a => typeof a === 'string' && a.startsWith('HTTPS_PROXY'))).toBeUndefined();
  });

  it('continues without OneCLI when ensureAgent throws', async () => {
    const ensureAgent = vi.fn().mockRejectedValue(new Error('gateway down'));
    const applyContainerConfig = vi.fn().mockResolvedValue(false);
    vi.doMock('@onecli-sh/sdk', () => ({
      OneCLI: class {
        ensureAgent = ensureAgent;
        applyContainerConfig = applyContainerConfig;
      },
    }));
    vi.doMock('../config.js', () => ({
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      CONTAINER_MAX_OUTPUT_SIZE: 10485760,
      CONTAINER_TIMEOUT: 1800000,
      DATA_DIR: '/tmp/nanoclaw-test-data',
      GROUPS_DIR: '/tmp/nanoclaw-test-groups',
      IDLE_TIMEOUT: 1800000,
      INSTALL_SLUG: 'nanoclaw-test',
      ONECLI_URL: 'http://127.0.0.1:10254',
      ONECLI_API_KEY: '',
    }));
    vi.doMock('../logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting([], 'nc-test', 'main');

    // Test passes if no throw escapes buildContainerArgs.
    expect(args).toContain('--rm');
    expect(applyContainerConfig).not.toHaveBeenCalled();
    expect(args.find((a) => typeof a === 'string' && a.startsWith('HTTPS_PROXY'))).toBeUndefined();
  });

  it('Phase 5A: sets NANOCLAW_AGENT_PROVIDER=claude by default', async () => {
    vi.doMock('@onecli-sh/sdk', () => ({
      OneCLI: class {
        ensureAgent = vi.fn().mockResolvedValue(undefined);
        applyContainerConfig = vi.fn().mockResolvedValue(false);
      },
    }));
    vi.doMock('../config.js', () => ({
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      CONTAINER_MAX_OUTPUT_SIZE: 10485760,
      CONTAINER_TIMEOUT: 1800000,
      DATA_DIR: '/tmp/nanoclaw-test-data',
      GROUPS_DIR: '/tmp/nanoclaw-test-groups',
      IDLE_TIMEOUT: 1800000,
      INSTALL_SLUG: 'nanoclaw-test',
      ONECLI_URL: 'http://127.0.0.1:10254',
      ONECLI_API_KEY: '',
    }));
    vi.doMock('../logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting([], 'nc-test', undefined);
    expect(args).toContain('NANOCLAW_AGENT_PROVIDER=claude');
  });

  it('Phase 5A: NANOCLAW_AGENT_PROVIDER reflects group.agent_provider', async () => {
    vi.doMock('@onecli-sh/sdk', () => ({
      OneCLI: class {
        ensureAgent = vi.fn().mockResolvedValue(undefined);
        applyContainerConfig = vi.fn().mockResolvedValue(false);
      },
    }));
    vi.doMock('../config.js', () => ({
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      CONTAINER_MAX_OUTPUT_SIZE: 10485760,
      CONTAINER_TIMEOUT: 1800000,
      DATA_DIR: '/tmp/nanoclaw-test-data',
      GROUPS_DIR: '/tmp/nanoclaw-test-groups',
      IDLE_TIMEOUT: 1800000,
      INSTALL_SLUG: 'nanoclaw-test',
      ONECLI_URL: 'http://127.0.0.1:10254',
      ONECLI_API_KEY: '',
    }));
    vi.doMock('../logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const fakeGroup = {
      id: 'g1',
      name: 'g1',
      folder: 'g1',
      agent_provider: 'codex',
      container_config: null,
      created_at: '2026-04-26',
    } as unknown as Parameters<typeof buildContainerArgsForTesting>[3];
    const args = await buildContainerArgsForTesting([], 'nc-test', 'g1', fakeGroup);
    expect(args).toContain('NANOCLAW_AGENT_PROVIDER=codex');
  });

  it('skips ensureAgent when agentIdentifier is undefined but still calls applyContainerConfig', async () => {
    const ensureAgent = vi.fn().mockResolvedValue(undefined);
    const applyContainerConfig = vi.fn().mockResolvedValue(false);
    vi.doMock('@onecli-sh/sdk', () => ({
      OneCLI: class {
        ensureAgent = ensureAgent;
        applyContainerConfig = applyContainerConfig;
      },
    }));
    vi.doMock('../config.js', () => ({
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      CONTAINER_MAX_OUTPUT_SIZE: 10485760,
      CONTAINER_TIMEOUT: 1800000,
      DATA_DIR: '/tmp/nanoclaw-test-data',
      GROUPS_DIR: '/tmp/nanoclaw-test-groups',
      IDLE_TIMEOUT: 1800000,
      INSTALL_SLUG: 'nanoclaw-test',
      ONECLI_URL: 'http://127.0.0.1:10254',
      ONECLI_API_KEY: '',
    }));
    vi.doMock('../logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting([], 'nc-test', undefined);
    expect(ensureAgent).not.toHaveBeenCalled();
    expect(applyContainerConfig).toHaveBeenCalledWith(args, expect.objectContaining({ agent: undefined }));
    expect(args).toContain('--rm');
  });
});
