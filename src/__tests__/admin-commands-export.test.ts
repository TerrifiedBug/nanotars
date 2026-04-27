import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeAdminCommandsJson, ADMIN_COMMANDS_JSON_FILENAME } from '../admin-commands-export.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-commands-export-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeAdminCommandsJson', () => {
  it('writes to <dataDir>/admin-commands.json', () => {
    writeAdminCommandsJson(tmpDir);
    const target = path.join(tmpDir, ADMIN_COMMANDS_JSON_FILENAME);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('contains an array of {name, description, usage} objects', () => {
    writeAdminCommandsJson(tmpDir);
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, ADMIN_COMMANDS_JSON_FILENAME), 'utf-8'));
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);
    for (const entry of content) {
      expect(entry).toMatchObject({
        name: expect.any(String),
        description: expect.any(String),
        usage: expect.any(String),
      });
      expect(entry.name).toMatch(/^\//);
    }
  });

  it('includes /help and /grant', () => {
    writeAdminCommandsJson(tmpDir);
    const content: Array<{ name: string }> = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ADMIN_COMMANDS_JSON_FILENAME), 'utf-8'),
    );
    const names = content.map((c) => c.name);
    expect(names).toContain('/help');
    expect(names).toContain('/grant');
  });

  it('writes atomically — file content is always valid JSON after return', () => {
    writeAdminCommandsJson(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, ADMIN_COMMANDS_JSON_FILENAME), 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('overwrites an existing file on subsequent calls', () => {
    fs.writeFileSync(path.join(tmpDir, ADMIN_COMMANDS_JSON_FILENAME), 'stale-content', 'utf-8');
    writeAdminCommandsJson(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, ADMIN_COMMANDS_JSON_FILENAME), 'utf-8');
    expect(content).not.toBe('stale-content');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('creates dataDir if it does not exist', () => {
    const nonExistent = path.join(tmpDir, 'nested', 'dir');
    writeAdminCommandsJson(nonExistent);
    const target = path.join(nonExistent, ADMIN_COMMANDS_JSON_FILENAME);
    expect(fs.existsSync(target)).toBe(true);
  });
});
