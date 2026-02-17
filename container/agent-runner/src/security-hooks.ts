/**
 * Security hooks for the agent runner.
 * Prevents secrets from leaking to agent-spawned Bash commands
 * and blocks reading sensitive files.
 */

import { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

/** Env vars that must never leak to agent-spawned processes. */
export const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

// PreToolUse hook for Bash: prepends `unset` for secret env vars
// and blocks commands that try to read /proc/{pid}/environ.
export function createSanitizeBashHook(): HookCallback {
  return async (input) => {
    const h = input as PreToolUseHookInput;
    if (h.tool_name !== 'Bash') return {};

    const toolInput = h.tool_input as Record<string, unknown>;
    if (typeof toolInput?.command !== 'string') return {};

    const command = toolInput.command;

    // Block attempts to read /proc/*/environ (secrets in process memory)
    if (/\/proc\/.*\/environ/.test(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: h.hook_event_name,
          permissionDecision: 'deny' as const,
          reason: 'Access to /proc/*/environ is blocked for security reasons',
        },
      };
    }

    // Block attempts to read .credentials.json (OAuth token)
    if (/\.credentials\.json/.test(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: h.hook_event_name,
          permissionDecision: 'deny' as const,
          reason: 'Access to .credentials.json is blocked for security reasons',
        },
      };
    }

    // Prepend unset for secret vars so child shells can't access them
    const unsetPrefix = SECRET_ENV_VARS.map(v => `unset ${v}`).join('; ');
    return {
      hookSpecificOutput: {
        hookEventName: h.hook_event_name,
        permissionDecision: 'allow' as const,
        updatedInput: {
          ...toolInput,
          command: `${unsetPrefix}; ${command}`,
        },
      },
    };
  };
}

/**
 * PreToolUse hook for Read: blocks reading sensitive file paths.
 */
export function createSecretPathBlockHook(): HookCallback {
  return async (input) => {
    const h = input as PreToolUseHookInput;
    if (h.tool_name !== 'Read') return {};

    const toolInput = h.tool_input as Record<string, unknown>;
    const filePath = typeof toolInput?.file_path === 'string' ? toolInput.file_path : '';

    // Block /proc/*/environ
    if (/\/proc\/.*\/environ/.test(filePath)) {
      return {
        hookSpecificOutput: {
          hookEventName: h.hook_event_name,
          permissionDecision: 'deny' as const,
          reason: 'Access to /proc/*/environ is blocked for security reasons',
        },
      };
    }

    // Block /tmp/input.json (container input with secrets)
    if (filePath === '/tmp/input.json') {
      return {
        hookSpecificOutput: {
          hookEventName: h.hook_event_name,
          permissionDecision: 'deny' as const,
          reason: 'Access to container input file is blocked for security reasons',
        },
      };
    }

    // Block .credentials.json (OAuth token)
    if (filePath.endsWith('.credentials.json')) {
      return {
        hookSpecificOutput: {
          hookEventName: h.hook_event_name,
          permissionDecision: 'deny' as const,
          reason: 'Access to .credentials.json is blocked for security reasons',
        },
      };
    }

    return {};
  };
}
