import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { composeGroupClaudeMd } from '../claude-md-compose.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-compose-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readClaudeMd(folder: string): string {
  return fs.readFileSync(path.join(tmpDir, 'groups', folder, 'CLAUDE.md'), 'utf-8');
}

function groupDir(folder: string): string {
  return path.join(tmpDir, 'groups', folder);
}

describe('composeGroupClaudeMd', () => {
  // Test 1: Writes CLAUDE.md with the shared-base import
  it('writes CLAUDE.md with the shared-base @./.claude-shared.md import', () => {
    composeGroupClaudeMd({ folder: 'mygroup' }, { projectRoot: tmpDir });

    const content = readClaudeMd('mygroup');
    expect(content).toContain('@./.claude-shared.md');
  });

  // Test 2: Creates an empty CLAUDE.local.md if missing
  it('creates an empty CLAUDE.local.md when it does not exist', () => {
    composeGroupClaudeMd({ folder: 'mygroup' }, { projectRoot: tmpDir });

    const localFile = path.join(groupDir('mygroup'), 'CLAUDE.local.md');
    expect(fs.existsSync(localFile)).toBe(true);
    expect(fs.readFileSync(localFile, 'utf-8')).toBe('');
  });

  // Test 3: Preserves existing CLAUDE.local.md content
  it('does not overwrite an existing CLAUDE.local.md', () => {
    const gDir = path.join(tmpDir, 'groups', 'mygroup');
    fs.mkdirSync(gDir, { recursive: true });
    const localFile = path.join(gDir, 'CLAUDE.local.md');
    fs.writeFileSync(localFile, '# My existing memory\nsome content\n');

    composeGroupClaudeMd({ folder: 'mygroup' }, { projectRoot: tmpDir });

    expect(fs.readFileSync(localFile, 'utf-8')).toBe('# My existing memory\nsome content\n');
  });

  // Test 4: Imports skill fragments from plugins with container-skills/<name>/instructions.md
  it('imports skill fragments from plugins that ship container-skills/<name>/instructions.md', () => {
    // Create a plugin with an instructions.md
    const pluginSkillDir = path.join(tmpDir, 'plugins', 'myplugin', 'container-skills', 'myjskill');
    fs.mkdirSync(pluginSkillDir, { recursive: true });
    fs.writeFileSync(path.join(pluginSkillDir, 'instructions.md'), '# My skill instructions\n');

    composeGroupClaudeMd({ folder: 'mygroup' }, { projectRoot: tmpDir });

    const content = readClaudeMd('mygroup');
    expect(content).toContain('@./.claude-fragments/skill-myjskill.md');
  });

  // Test 5: Inlines fragment content (v1 doesn't symlink to container paths)
  it('inlines fragment content into .claude-fragments/ rather than symlinking', () => {
    const pluginSkillDir = path.join(tmpDir, 'plugins', 'myplugin', 'container-skills', 'myjskill');
    fs.mkdirSync(pluginSkillDir, { recursive: true });
    const instructionsContent = '# Inline skill instructions\nDo something useful.\n';
    fs.writeFileSync(path.join(pluginSkillDir, 'instructions.md'), instructionsContent);

    composeGroupClaudeMd({ folder: 'mygroup' }, { projectRoot: tmpDir });

    const fragmentPath = path.join(groupDir('mygroup'), '.claude-fragments', 'skill-myjskill.md');
    expect(fs.existsSync(fragmentPath)).toBe(true);
    // It must be a regular file (not a symlink) containing the instructions content
    const stat = fs.lstatSync(fragmentPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(fragmentPath, 'utf-8')).toBe(instructionsContent);
  });

  // Test 6: Prunes stale fragments when a plugin is uninstalled
  it('prunes stale fragments that no longer have a source plugin', () => {
    // First compose: plugin present
    const pluginSkillDir = path.join(tmpDir, 'plugins', 'myplugin', 'container-skills', 'myjskill');
    fs.mkdirSync(pluginSkillDir, { recursive: true });
    fs.writeFileSync(path.join(pluginSkillDir, 'instructions.md'), '# skill\n');

    composeGroupClaudeMd({ folder: 'mygroup' }, { projectRoot: tmpDir });

    const fragmentPath = path.join(groupDir('mygroup'), '.claude-fragments', 'skill-myjskill.md');
    expect(fs.existsSync(fragmentPath)).toBe(true);

    // Remove plugin (simulate uninstall)
    fs.rmSync(path.join(tmpDir, 'plugins', 'myplugin'), { recursive: true });

    // Second compose: stale fragment should be pruned
    composeGroupClaudeMd({ folder: 'mygroup' }, { projectRoot: tmpDir });

    expect(fs.existsSync(fragmentPath)).toBe(false);
    expect(readClaudeMd('mygroup')).not.toContain('skill-myjskill.md');
  });

  // Test 7: Final CLAUDE.md ends with @./CLAUDE.local.md import
  it('includes @./CLAUDE.local.md as the last import line in CLAUDE.md', () => {
    composeGroupClaudeMd({ folder: 'mygroup' }, { projectRoot: tmpDir });

    const lines = readClaudeMd('mygroup').split('\n').filter((l) => l.trim().startsWith('@'));
    expect(lines[lines.length - 1]).toBe('@./CLAUDE.local.md');
  });

  // Test 8: Idempotent — running twice produces identical output
  it('is idempotent — running compose twice produces the same CLAUDE.md', () => {
    const pluginSkillDir = path.join(tmpDir, 'plugins', 'myplugin', 'container-skills', 'myjskill');
    fs.mkdirSync(pluginSkillDir, { recursive: true });
    fs.writeFileSync(path.join(pluginSkillDir, 'instructions.md'), '# skill instructions\n');

    composeGroupClaudeMd({ folder: 'mygroup' }, { projectRoot: tmpDir });
    const first = readClaudeMd('mygroup');

    composeGroupClaudeMd({ folder: 'mygroup' }, { projectRoot: tmpDir });
    const second = readClaudeMd('mygroup');

    expect(first).toBe(second);
  });
});
