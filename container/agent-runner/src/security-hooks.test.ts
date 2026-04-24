import { describe, expect, it } from 'bun:test';

import { sanitizeBashHook, secretPathBlockHook, SECRET_ENV_VARS } from './security-hooks';

type HookResult = {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
};

const call = async (hook: typeof sanitizeBashHook, toolName: string, toolInput: Record<string, unknown>) => {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  } as unknown as Parameters<typeof sanitizeBashHook>[0];
  const extra = {} as unknown as Parameters<typeof sanitizeBashHook>[1];
  const opts = {} as unknown as Parameters<typeof sanitizeBashHook>[2];
  return (await hook(input, extra, opts)) as HookResult;
};

describe('sanitizeBashHook', () => {
  it('passes non-Bash tools through untouched', async () => {
    const res = await call(sanitizeBashHook, 'Read', { file_path: '/etc/hosts' });
    expect(res).toEqual({});
  });

  it('denies /proc/*/environ reads', async () => {
    const res = await call(sanitizeBashHook, 'Bash', { command: 'cat /proc/1/environ' });
    expect(res.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(res.hookSpecificOutput?.permissionDecisionReason).toMatch(/\/proc\/.*\/environ/);
  });

  it('denies subshell /proc/environ tricks', async () => {
    const res = await call(sanitizeBashHook, 'Bash', { command: 'echo $(cat /proc/self/environ)' });
    expect(res.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies backtick /proc/environ tricks', async () => {
    const res = await call(sanitizeBashHook, 'Bash', { command: 'echo `cat /proc/self/environ`' });
    expect(res.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies /tmp/input.json reads', async () => {
    const res = await call(sanitizeBashHook, 'Bash', { command: 'cat /tmp/input.json' });
    expect(res.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies .credentials.json reads', async () => {
    const res = await call(sanitizeBashHook, 'Bash', { command: 'cat ~/.claude/.credentials.json' });
    expect(res.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies python reading /proc/ paths', async () => {
    const res = await call(sanitizeBashHook, 'Bash', {
      command: 'python3 -c "print(open(\'/proc/1/status\').read())"',
    });
    expect(res.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('allows benign commands with unset prefix', async () => {
    const res = await call(sanitizeBashHook, 'Bash', { command: 'ls -la' });
    expect(res.hookSpecificOutput?.permissionDecision).toBe('allow');
    const cmd = res.hookSpecificOutput?.updatedInput?.command as string;
    for (const v of SECRET_ENV_VARS) expect(cmd).toContain(`unset ${v}`);
    expect(cmd).toContain('; ls -la');
  });

  it('preserves other tool_input fields when allowing', async () => {
    const res = await call(sanitizeBashHook, 'Bash', { command: 'echo ok', timeout: 30000, description: 'd' });
    expect(res.hookSpecificOutput?.updatedInput?.timeout).toBe(30000);
    expect(res.hookSpecificOutput?.updatedInput?.description).toBe('d');
  });

  it('missing command field is a no-op', async () => {
    const res = await call(sanitizeBashHook, 'Bash', {});
    expect(res).toEqual({});
  });
});

describe('secretPathBlockHook', () => {
  it('passes non-Read tools through untouched', async () => {
    const res = await call(secretPathBlockHook, 'Bash', { command: 'ls' });
    expect(res).toEqual({});
  });

  it('denies /proc/*/environ', async () => {
    const res = await call(secretPathBlockHook, 'Read', { file_path: '/proc/1/environ' });
    expect(res.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies /tmp/input.json', async () => {
    const res = await call(secretPathBlockHook, 'Read', { file_path: '/tmp/input.json' });
    expect(res.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies .credentials.json endings', async () => {
    const res = await call(secretPathBlockHook, 'Read', { file_path: '/home/node/.claude/.credentials.json' });
    expect(res.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('allows other paths', async () => {
    const res = await call(secretPathBlockHook, 'Read', { file_path: '/workspace/agent/CLAUDE.md' });
    expect(res).toEqual({});
  });
});
