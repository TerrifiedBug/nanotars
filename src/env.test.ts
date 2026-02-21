import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-test-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterEach(() => {
  cwdSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEnv(content: string): void {
  fs.writeFileSync(path.join(tmpDir, '.env'), content);
}

describe('readEnvFile', () => {
  it('reads requested keys from .env', () => {
    writeEnv('FOO=bar\nBAZ=qux');
    expect(readEnvFile(['FOO', 'BAZ'])).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('returns empty object when .env is missing', () => {
    expect(readEnvFile(['FOO'])).toEqual({});
  });

  it('ignores unrequested keys', () => {
    writeEnv('FOO=bar\nSECRET=hidden');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'bar' });
  });

  it('strips double quotes from values', () => {
    writeEnv('FOO="hello world"');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'hello world' });
  });

  it('strips single quotes from values', () => {
    writeEnv("FOO='hello world'");
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'hello world' });
  });

  it('does not strip mismatched quotes', () => {
    writeEnv('FOO="hello\'');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: '"hello\'' });
  });

  it('skips comment lines', () => {
    writeEnv('# this is a comment\nFOO=bar');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'bar' });
  });

  it('skips empty lines', () => {
    writeEnv('\n\nFOO=bar\n\n');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'bar' });
  });

  it('skips lines without =', () => {
    writeEnv('INVALID_LINE\nFOO=bar');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'bar' });
  });

  it('handles = in value portion', () => {
    writeEnv('FOO=bar=baz=qux');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'bar=baz=qux' });
  });

  it('trims whitespace around keys', () => {
    writeEnv('  FOO  = bar');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'bar' });
  });

  it('omits keys with empty values', () => {
    writeEnv('FOO=\nBAR=value');
    expect(readEnvFile(['FOO', 'BAR'])).toEqual({ BAR: 'value' });
  });

  it('returns empty object for empty key list', () => {
    writeEnv('FOO=bar');
    expect(readEnvFile([])).toEqual({});
  });
});
