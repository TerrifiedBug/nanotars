import { describe, it, expect } from 'vitest';
import { SECRET_ENV_VARS, createSanitizeBashHook, createSecretPathBlockHook } from './security-hooks.js';

function makePreToolUseInput(toolName: string, toolInput: Record<string, unknown>) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  };
}

describe('SECRET_ENV_VARS', () => {
  it('contains ANTHROPIC_API_KEY', () => {
    expect(SECRET_ENV_VARS).toContain('ANTHROPIC_API_KEY');
  });

  it('contains CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(SECRET_ENV_VARS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});

describe('createSanitizeBashHook', () => {
  const hook = createSanitizeBashHook();

  it('prepends unset commands to Bash commands', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'echo hello' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('allow');
    expect(output.updatedInput.command).toBe(
      'unset ANTHROPIC_API_KEY; unset CLAUDE_CODE_OAUTH_TOKEN; echo hello',
    );
  });

  it('blocks commands reading /proc/self/environ', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'cat /proc/self/environ' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
  });

  it('blocks commands reading /proc/1/environ', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'cat /proc/1/environ' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
  });

  it('blocks commands reading .credentials.json via cat', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'cat /home/node/.claude/.credentials.json' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
  });

  it('blocks commands piping .credentials.json', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'jq .accessToken < /home/node/.claude/.credentials.json' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
  });

  it('blocks more reading /proc/cpuinfo', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'more /proc/cpuinfo' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
    expect(output.reason).toMatch(/sensitive paths/);
  });

  it('blocks od reading /proc/version', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'od -c /proc/version' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
    expect(output.reason).toMatch(/sensitive paths/);
  });

  it('blocks hexdump reading /proc/self/maps', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'hexdump -C /proc/self/maps' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
    expect(output.reason).toMatch(/sensitive paths/);
  });

  it('blocks python3 reading /proc/cpuinfo', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'python3 -c "open(\'/proc/cpuinfo\').read()"' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
    expect(output.reason).toMatch(/sensitive paths/);
  });

  it('blocks bun reading /proc/cpuinfo', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'bun -e "console.log(require(\'fs\').readFileSync(\'/proc/cpuinfo\').toString())"' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
    expect(output.reason).toMatch(/sensitive paths/);
  });

  it('blocks awk reading /proc/cpuinfo', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'awk \'{print}\' /proc/cpuinfo' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
    expect(output.reason).toMatch(/sensitive paths/);
  });

  it('blocks sed reading /proc/version', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'sed -n 1p /proc/version' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
    expect(output.reason).toMatch(/sensitive paths/);
  });

  it('ignores non-Bash tools', async () => {
    const result = await hook(makePreToolUseInput('Read', { file_path: '/etc/passwd' }));
    expect(result).toEqual({});
  });

  it('ignores Bash with no command string', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 123 }));
    expect(result).toEqual({});
  });
});

describe('createSecretPathBlockHook', () => {
  const hook = createSecretPathBlockHook();

  it('blocks reading /proc/self/environ', async () => {
    const result = await hook(makePreToolUseInput('Read', { file_path: '/proc/self/environ' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
  });

  it('blocks reading /proc/1/environ', async () => {
    const result = await hook(makePreToolUseInput('Read', { file_path: '/proc/1/environ' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
  });

  it('blocks reading /tmp/input.json', async () => {
    const result = await hook(makePreToolUseInput('Read', { file_path: '/tmp/input.json' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
  });

  it('blocks reading .credentials.json directly', async () => {
    const result = await hook(makePreToolUseInput('Read', { file_path: '/home/node/.claude/.credentials.json' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
  });

  it('blocks reading .credentials.json at any path', async () => {
    const result = await hook(makePreToolUseInput('Read', { file_path: '/some/other/path/.credentials.json' }));
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
  });

  it('allows reading normal files', async () => {
    const result = await hook(makePreToolUseInput('Read', { file_path: '/workspace/group/CLAUDE.md' }));
    expect(result).toEqual({});
  });

  it('ignores non-Read tools', async () => {
    const result = await hook(makePreToolUseInput('Bash', { command: 'ls' }));
    expect(result).toEqual({});
  });
});
