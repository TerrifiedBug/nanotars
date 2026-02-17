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
