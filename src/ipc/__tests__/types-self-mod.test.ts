/**
 * Phase 5C-01 — type guards + TASK_IPC_TYPES wiring for the self-mod
 * IPC payloads (`install_packages`, `add_mcp_server`).
 *
 * The runtime validation surface is small: a discriminator-based guard
 * and the `isValidTaskIpc` allowlist. Both are pure functions, so these
 * tests run without DB or filesystem setup.
 */
import { describe, it, expect } from 'vitest';

import {
  isAddMcpServerTask,
  isInstallPackagesTask,
  isValidTaskIpc,
  type AddMcpServerTask,
  type InstallPackagesTask,
} from '../types.js';

describe('isInstallPackagesTask', () => {
  it('returns true on a well-formed install_packages payload', () => {
    const task: InstallPackagesTask = {
      type: 'install_packages',
      apt: ['curl'],
      npm: [],
      reason: 'need curl',
      groupFolder: 'main',
      isMain: true,
      timestamp: '2026-04-26T12:00:00.000Z',
    };
    expect(isInstallPackagesTask(task)).toBe(true);
  });

  it('returns false on a sibling task type', () => {
    expect(isInstallPackagesTask({ type: 'add_mcp_server' })).toBe(false);
    expect(isInstallPackagesTask({ type: 'create_agent' })).toBe(false);
    expect(isInstallPackagesTask({ type: 'emergency_stop' })).toBe(false);
  });
});

describe('isAddMcpServerTask', () => {
  it('returns true on a well-formed add_mcp_server payload', () => {
    const task: AddMcpServerTask = {
      type: 'add_mcp_server',
      name: 'my-server',
      command: 'npx',
      args: ['-y', '@some/mcp'],
      env: { TOKEN: 'x' },
      groupFolder: 'main',
      isMain: true,
      timestamp: '2026-04-26T12:00:00.000Z',
    };
    expect(isAddMcpServerTask(task)).toBe(true);
  });

  it('returns false on a sibling task type', () => {
    expect(isAddMcpServerTask({ type: 'install_packages' })).toBe(false);
    expect(isAddMcpServerTask({ type: 'register_group' })).toBe(false);
  });
});

describe('isValidTaskIpc allowlist', () => {
  it('accepts install_packages and add_mcp_server', () => {
    expect(isValidTaskIpc({ type: 'install_packages' })).toBe(true);
    expect(isValidTaskIpc({ type: 'add_mcp_server' })).toBe(true);
  });

  it('still accepts the prior task types (no regression)', () => {
    expect(isValidTaskIpc({ type: 'schedule_task' })).toBe(true);
    expect(isValidTaskIpc({ type: 'register_group' })).toBe(true);
    expect(isValidTaskIpc({ type: 'create_agent' })).toBe(true);
    expect(isValidTaskIpc({ type: 'emergency_stop' })).toBe(true);
  });

  it('rejects unknown types', () => {
    expect(isValidTaskIpc({ type: 'install_random_thing' })).toBe(false);
    expect(isValidTaskIpc({ type: '' })).toBe(false);
  });

  it('rejects non-objects and missing type field', () => {
    expect(isValidTaskIpc(null)).toBe(false);
    expect(isValidTaskIpc(undefined)).toBe(false);
    expect(isValidTaskIpc('install_packages')).toBe(false);
    expect(isValidTaskIpc({})).toBe(false);
  });
});
