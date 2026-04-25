import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { runScript } from '../task-script.js';

describe('runScript', () => {
  it('returns null when script errors (non-zero exit)', async () => {
    const result = await runScript('exit 1', 'task-1');
    expect(result).toBe(null);
  });

  it('returns null when last line is not JSON', async () => {
    const result = await runScript('echo hello', 'task-1');
    expect(result).toBe(null);
  });

  it('returns the parsed object when last line is valid JSON', async () => {
    const result = await runScript(`echo '{"wakeAgent":true,"data":{"x":1}}'`, 'task-1');
    expect(result).toEqual({ wakeAgent: true, data: { x: 1 } });
  });

  it('returns null when JSON lacks wakeAgent boolean', async () => {
    const result = await runScript(`echo '{"data":1}'`, 'task-1');
    expect(result).toBe(null);
  });

  it('returns wakeAgent:false correctly', async () => {
    const result = await runScript(`echo '{"wakeAgent":false}'`, 'task-1');
    expect(result).toEqual({ wakeAgent: false });
  });

  it('cleans up the temp script file', async () => {
    await runScript('echo \'{"wakeAgent":true}\'', 'cleanup-test');
    expect(fs.existsSync('/tmp/task-script-cleanup-test.sh')).toBe(false);
  });
});
