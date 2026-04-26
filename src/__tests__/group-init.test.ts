import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    GROUPS_DIR: '/tmp/__replaced__',
  };
});

import * as configMod from '../config.js';
import { initGroupFilesystem } from '../group-init.js';
import type { AgentGroup } from '../types.js';

let tmpDir: string;
let groupsDir: string;

function makeGroup(folder: string): AgentGroup {
  return {
    id: `ag-${folder}`,
    name: folder,
    folder,
    agent_provider: null,
    container_config: null,
    created_at: '2026-04-26T00:00:00.000Z',
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-groupinit-'));
  groupsDir = path.join(tmpDir, 'groups');
  fs.mkdirSync(groupsDir, { recursive: true });
  (configMod as { GROUPS_DIR: string }).GROUPS_DIR = groupsDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('initGroupFilesystem', () => {
  it('creates the group folder', () => {
    initGroupFilesystem(makeGroup('researcher'), {});
    expect(fs.existsSync(path.join(groupsDir, 'researcher'))).toBe(true);
    expect(fs.statSync(path.join(groupsDir, 'researcher')).isDirectory()).toBe(true);
  });

  it('writes CLAUDE.md when instructions are provided', () => {
    initGroupFilesystem(makeGroup('researcher'), {
      instructions: 'You are a research assistant',
    });
    const claudeMd = path.join(groupsDir, 'researcher', 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(true);
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe('You are a research assistant');
  });

  it('skips CLAUDE.md when instructions are omitted', () => {
    initGroupFilesystem(makeGroup('researcher'), {});
    expect(fs.existsSync(path.join(groupsDir, 'researcher', 'CLAUDE.md'))).toBe(false);
  });

  it('skips CLAUDE.md when instructions are an empty string', () => {
    initGroupFilesystem(makeGroup('researcher'), { instructions: '' });
    expect(fs.existsSync(path.join(groupsDir, 'researcher', 'CLAUDE.md'))).toBe(false);
  });

  it('copies IDENTITY.md from groups/global/IDENTITY.md when present', () => {
    fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'IDENTITY.md'),
      '# Default Identity\n',
    );

    initGroupFilesystem(makeGroup('researcher'), {});

    const identity = path.join(groupsDir, 'researcher', 'IDENTITY.md');
    expect(fs.existsSync(identity)).toBe(true);
    expect(fs.readFileSync(identity, 'utf-8')).toBe('# Default Identity\n');
  });

  it('skips IDENTITY.md silently when groups/global/IDENTITY.md is missing', () => {
    initGroupFilesystem(makeGroup('researcher'), {});
    expect(fs.existsSync(path.join(groupsDir, 'researcher', 'IDENTITY.md'))).toBe(false);
  });

  it('does not overwrite an existing IDENTITY.md', () => {
    fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'IDENTITY.md'),
      '# Global identity\n',
    );
    fs.mkdirSync(path.join(groupsDir, 'researcher'), { recursive: true });
    fs.writeFileSync(
      path.join(groupsDir, 'researcher', 'IDENTITY.md'),
      '# Custom identity\n',
    );

    initGroupFilesystem(makeGroup('researcher'), {});

    const identity = path.join(groupsDir, 'researcher', 'IDENTITY.md');
    expect(fs.readFileSync(identity, 'utf-8')).toBe('# Custom identity\n');
  });

  it('rejects a folder that escapes GROUPS_DIR via ..', () => {
    // We can pass an arbitrary AgentGroup row; the path-traversal guard is
    // the last line of defense after IPC + handler regex checks.
    const escapingGroup: AgentGroup = {
      ...makeGroup('researcher'),
      folder: '../escape',
    };
    expect(() => initGroupFilesystem(escapingGroup, {})).toThrow(
      /escapes groups dir/,
    );
    expect(fs.existsSync(path.join(tmpDir, 'escape'))).toBe(false);
  });

  it('rejects a folder that resolves to GROUPS_DIR itself', () => {
    const dotGroup: AgentGroup = {
      ...makeGroup('researcher'),
      folder: '.',
    };
    expect(() => initGroupFilesystem(dotGroup, {})).toThrow(
      /cannot equal groups dir|escapes groups dir/,
    );
  });

  it('absolute-style folder is normalised to a child of GROUPS_DIR (defense via regex on caller)', () => {
    // path.join('/tmp/groups', '/etc') === '/tmp/groups/etc'. The host
    // handler's FOLDER_RE rejects leading slashes before this code runs,
    // so this path is a defense-in-depth check that the path-traversal
    // guard does NOT spuriously throw on a normal nested folder name.
    const absGroup: AgentGroup = {
      ...makeGroup('researcher'),
      folder: '/etc',
    };
    expect(() => initGroupFilesystem(absGroup, {})).not.toThrow();
    // The created folder lives under GROUPS_DIR, not at /etc.
    expect(fs.existsSync(path.join(groupsDir, 'etc'))).toBe(true);
  });
});
