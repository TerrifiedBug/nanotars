import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// config.ts reads env at module load time, so we need vi.resetModules() + dynamic import
// to test different env scenarios.

// Mock readEnvFile to avoid filesystem dependency
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  vi.resetModules();
});

afterEach(() => {
  process.env = originalEnv;
});

describe('CONTAINER_TIMEOUT', () => {
  it('defaults to 1800000', async () => {
    delete process.env.CONTAINER_TIMEOUT;
    const { CONTAINER_TIMEOUT } = await import('./config.js');
    expect(CONTAINER_TIMEOUT).toBe(1800000);
  });

  it('reads from env override', async () => {
    process.env.CONTAINER_TIMEOUT = '60000';
    const { CONTAINER_TIMEOUT } = await import('./config.js');
    expect(CONTAINER_TIMEOUT).toBe(60000);
  });
});

describe('MAX_CONCURRENT_CONTAINERS', () => {
  it('defaults to 5', async () => {
    delete process.env.MAX_CONCURRENT_CONTAINERS;
    const { MAX_CONCURRENT_CONTAINERS } = await import('./config.js');
    expect(MAX_CONCURRENT_CONTAINERS).toBe(5);
  });

  it('respects env override', async () => {
    process.env.MAX_CONCURRENT_CONTAINERS = '10';
    const { MAX_CONCURRENT_CONTAINERS } = await import('./config.js');
    expect(MAX_CONCURRENT_CONTAINERS).toBe(10);
  });

  it('enforces minimum of 1 for negative values', async () => {
    process.env.MAX_CONCURRENT_CONTAINERS = '-1';
    const { MAX_CONCURRENT_CONTAINERS } = await import('./config.js');
    expect(MAX_CONCURRENT_CONTAINERS).toBe(1);
  });

  it('treats 0 as falsy and falls back to default', async () => {
    process.env.MAX_CONCURRENT_CONTAINERS = '0';
    const { MAX_CONCURRENT_CONTAINERS } = await import('./config.js');
    expect(MAX_CONCURRENT_CONTAINERS).toBe(5);
  });

  it('falls back to 5 for NaN', async () => {
    process.env.MAX_CONCURRENT_CONTAINERS = 'notanumber';
    const { MAX_CONCURRENT_CONTAINERS } = await import('./config.js');
    expect(MAX_CONCURRENT_CONTAINERS).toBe(5);
  });
});

describe('ASSISTANT_NAME', () => {
  it('defaults to TARS', async () => {
    delete process.env.ASSISTANT_NAME;
    const { ASSISTANT_NAME } = await import('./config.js');
    expect(ASSISTANT_NAME).toBe('TARS');
  });

  it('reads from env override', async () => {
    process.env.ASSISTANT_NAME = 'CustomBot';
    const { ASSISTANT_NAME } = await import('./config.js');
    expect(ASSISTANT_NAME).toBe('CustomBot');
  });
});

describe('CONTAINER_IMAGE', () => {
  it('defaults to nanoclaw-agent:latest', async () => {
    delete process.env.CONTAINER_IMAGE;
    const { CONTAINER_IMAGE } = await import('./config.js');
    expect(CONTAINER_IMAGE).toBe('nanoclaw-agent:latest');
  });

  it('reads from env override', async () => {
    process.env.CONTAINER_IMAGE = 'my-image:v2';
    const { CONTAINER_IMAGE } = await import('./config.js');
    expect(CONTAINER_IMAGE).toBe('my-image:v2');
  });
});

describe('path constants', () => {
  it('resolves STORE_DIR relative to cwd', async () => {
    const { STORE_DIR } = await import('./config.js');
    expect(STORE_DIR).toContain('store');
    expect(STORE_DIR).toBe(require('path').resolve(process.cwd(), 'store'));
  });

  it('resolves GROUPS_DIR relative to cwd', async () => {
    const { GROUPS_DIR } = await import('./config.js');
    expect(GROUPS_DIR).toBe(require('path').resolve(process.cwd(), 'groups'));
  });

  it('resolves DATA_DIR relative to cwd', async () => {
    const { DATA_DIR } = await import('./config.js');
    expect(DATA_DIR).toBe(require('path').resolve(process.cwd(), 'data'));
  });

  it('resolves CHANNELS_DIR under DATA_DIR', async () => {
    const { DATA_DIR, CHANNELS_DIR } = await import('./config.js');
    expect(CHANNELS_DIR).toBe(require('path').join(DATA_DIR, 'channels'));
  });
});

describe('IDLE_TIMEOUT', () => {
  it('defaults to 1800000', async () => {
    delete process.env.IDLE_TIMEOUT;
    const { IDLE_TIMEOUT } = await import('./config.js');
    expect(IDLE_TIMEOUT).toBe(1800000);
  });
});

describe('SCHEDULED_TASK_IDLE_TIMEOUT', () => {
  it('defaults to 30000', async () => {
    delete process.env.SCHEDULED_TASK_IDLE_TIMEOUT;
    const { SCHEDULED_TASK_IDLE_TIMEOUT } = await import('./config.js');
    expect(SCHEDULED_TASK_IDLE_TIMEOUT).toBe(30000);
  });
});
