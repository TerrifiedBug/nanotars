import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildGroupEnvMount, parseEnvFile, shellQuote } from './index.js';

describe('shellQuote', () => {
  it('wraps plain value in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('escapes inner single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('neutralises $() and backticks', () => {
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(shellQuote('`id`')).toBe("'`id`'");
  });

  it('handles embedded hash (comment char)', () => {
    expect(shellQuote('value#notacomment')).toBe("'value#notacomment'");
  });

  it('handles empty string', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('parseEnvFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-env-parse-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty for missing file', () => {
    expect(parseEnvFile(path.join(tmp, 'nope.env'))).toEqual({});
  });

  it('parses plain KEY=VALUE', () => {
    const p = path.join(tmp, '.env');
    fs.writeFileSync(p, 'FOO=bar\nBAZ=qux\n');
    expect(parseEnvFile(p)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips surrounding double and single quotes', () => {
    const p = path.join(tmp, '.env');
    fs.writeFileSync(p, 'A="hello world"\nB=\'keep spaces\'\n');
    expect(parseEnvFile(p)).toEqual({ A: 'hello world', B: 'keep spaces' });
  });

  it('ignores comments and blank lines', () => {
    const p = path.join(tmp, '.env');
    fs.writeFileSync(p, '# a comment\n\nFOO=bar\n# another\n');
    expect(parseEnvFile(p)).toEqual({ FOO: 'bar' });
  });

  it('preserves = inside values', () => {
    const p = path.join(tmp, '.env');
    fs.writeFileSync(p, 'URL=https://example.com/path?x=1&y=2\n');
    expect(parseEnvFile(p)).toEqual({ URL: 'https://example.com/path?x=1&y=2' });
  });
});

describe('buildGroupEnvMount', () => {
  let tmp: string;
  let projectRoot: string;
  let groupsDir: string;
  let dataDir: string;
  const agentGroupId = 'ag-test-1';
  const groupFolder = 'test-group';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-env-build-'));
    projectRoot = tmp;
    groupsDir = path.join(tmp, 'groups');
    dataDir = path.join(tmp, 'data');
    fs.mkdirSync(path.join(groupsDir, groupFolder), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const call = (allowlist: string[]) =>
    buildGroupEnvMount({ agentGroupId, groupFolder, allowlist, projectRoot, groupsDir, dataDir });

  it('returns null when allowlist is empty', () => {
    fs.writeFileSync(path.join(projectRoot, '.env'), 'FOO=bar\n');
    expect(call([])).toBeNull();
  });

  it('returns null when nothing in allowlist is present in env', () => {
    fs.writeFileSync(path.join(projectRoot, '.env'), 'FOO=bar\n');
    expect(call(['NOTHING_DEFINED'])).toBeNull();
  });

  it('writes staged file and returns mount when allowlisted key matches', () => {
    fs.writeFileSync(path.join(projectRoot, '.env'), 'FOO=global\nBAR=also\n');
    const mount = call(['FOO']);
    expect(mount).not.toBeNull();
    expect(mount!.containerPath).toBe('/workspace/env-dir');
    expect(mount!.readonly).toBe(true);
    const staged = fs.readFileSync(path.join(mount!.hostPath, 'env'), 'utf-8');
    expect(staged).toContain("FOO='global'");
    expect(staged).not.toContain('BAR');
  });

  it('group .env overrides global', () => {
    fs.writeFileSync(path.join(projectRoot, '.env'), 'KEY=global\n');
    fs.writeFileSync(path.join(groupsDir, groupFolder, '.env'), 'KEY=group\n');
    const mount = call(['KEY']);
    const staged = fs.readFileSync(path.join(mount!.hostPath, 'env'), 'utf-8');
    expect(staged).toContain("KEY='group'");
    expect(staged).not.toContain("'global'");
  });

  it('merges global + group keys', () => {
    fs.writeFileSync(path.join(projectRoot, '.env'), 'GLOBAL_KEY=g\n');
    fs.writeFileSync(path.join(groupsDir, groupFolder, '.env'), 'GROUP_KEY=r\n');
    const mount = call(['GLOBAL_KEY', 'GROUP_KEY']);
    const staged = fs.readFileSync(path.join(mount!.hostPath, 'env'), 'utf-8');
    expect(staged).toContain("GLOBAL_KEY='g'");
    expect(staged).toContain("GROUP_KEY='r'");
  });

  it('shell-quotes dangerous values', () => {
    fs.writeFileSync(path.join(projectRoot, '.env'), "EVIL=$(rm -rf /)\nAPOS=it's\n");
    const mount = call(['EVIL', 'APOS']);
    const staged = fs.readFileSync(path.join(mount!.hostPath, 'env'), 'utf-8');
    expect(staged).toContain("EVIL='$(rm -rf /)'");
    expect(staged).toContain("APOS='it'\\''s'");
  });

  it('works with no global .env (group-only)', () => {
    fs.writeFileSync(path.join(groupsDir, groupFolder, '.env'), 'ONLY=here\n');
    const mount = call(['ONLY']);
    const staged = fs.readFileSync(path.join(mount!.hostPath, 'env'), 'utf-8');
    expect(staged).toContain("ONLY='here'");
  });

  it('writes to data/env/<agentGroupId>/env', () => {
    fs.writeFileSync(path.join(projectRoot, '.env'), 'X=1\n');
    const mount = call(['X']);
    expect(mount!.hostPath).toBe(path.join(dataDir, 'env', agentGroupId));
  });
});
