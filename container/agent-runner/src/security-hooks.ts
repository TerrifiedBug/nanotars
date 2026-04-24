/**
 * Security hooks for the agent runner.
 *
 * Defense-in-depth against an agent being tricked into exfiltrating
 * credentials it shouldn't see — either by reading the container's
 * process env, the container-input JSON, or the Claude Code
 * credentials file. These hooks run as PreToolUse and deny before
 * the tool call fires.
 *
 * Ported from nanotars v1 container/agent-runner/src/security-hooks.ts.
 * V2 notes:
 *   - SECRET_ENV_VARS includes ONECLI_API_KEY since v2 uses OneCLI's
 *     gateway (HTTPS_PROXY) for Anthropic auth. The env var itself
 *     isn't passed to containers in normal flows, but defense-in-depth
 *     against any stray injection.
 *   - An unset prefix (unset ANTHROPIC_API_KEY; unset ...) is still
 *     prepended to every Bash command so spawned child shells can't
 *     access these vars even if they're somehow set.
 */
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

/** Env vars that must never leak to agent-spawned processes. */
export const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ONECLI_API_KEY'];

const PROC_ENVIRON_RE = /(?:\/proc\/[^\s]*\/environ|(?:\$\(|`)[^)`]*\/proc\/[^\s)]*\/environ)/;
const INPUT_JSON_RE = /\/tmp\/input\.json/;
const CREDS_JSON_RE = /\.credentials\.json/;
const READ_TOOLS_RE = /\b(?:cat|less|more|head|tail|base64|xxd|strings|od|hexdump|python|python3|node|bun|perl|ruby|awk|sed)\b/;
const SENSITIVE_PATH_RE = /(?:\.credentials|\/proc\/)/;

/**
 * PreToolUse hook for the Bash tool.
 *
 * Blocks: any command referencing /proc/\*\/environ, /tmp/input.json,
 * or .credentials.json. Also blocks combinations of file-reading
 * tools (cat, head, python, etc.) with sensitive-path fragments.
 *
 * Allows (with modification): every other Bash command — prepends
 * an "unset" prefix for SECRET_ENV_VARS so the spawned shell can't
 * read these even if the container process has them set.
 */
export const sanitizeBashHook: HookCallback = async (input) => {
  const h = input as PreToolUseHookInput;
  if (h.tool_name !== 'Bash') return {};

  const toolInput = h.tool_input as Record<string, unknown>;
  if (typeof toolInput?.command !== 'string') return {};
  const command = toolInput.command;

  const denied =
    (PROC_ENVIRON_RE.test(command) && 'Access to /proc/*/environ is blocked') ||
    (INPUT_JSON_RE.test(command) && 'Access to /tmp/input.json is blocked') ||
    (CREDS_JSON_RE.test(command) && 'Access to .credentials.json is blocked') ||
    (READ_TOOLS_RE.test(command) && SENSITIVE_PATH_RE.test(command) && 'Reading sensitive paths with file tools is blocked');

  if (denied) {
    return {
      hookSpecificOutput: {
        hookEventName: h.hook_event_name,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: `${denied} for security reasons.`,
      },
    };
  }

  // Prepend unsets. Child shells can't see these vars even if somehow set.
  const unsetPrefix = SECRET_ENV_VARS.map((v) => `unset ${v}`).join('; ');
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

/**
 * PreToolUse hook for the Read tool.
 *
 * Blocks reads of /proc/\*\/environ, /tmp/input.json, and any
 * path ending in .credentials.json. Everything else passes through.
 */
export const secretPathBlockHook: HookCallback = async (input) => {
  const h = input as PreToolUseHookInput;
  if (h.tool_name !== 'Read') return {};

  const toolInput = h.tool_input as Record<string, unknown>;
  const filePath = typeof toolInput?.file_path === 'string' ? toolInput.file_path : '';

  const reason =
    (PROC_ENVIRON_RE.test(filePath) && 'Access to /proc/*/environ is blocked') ||
    (filePath === '/tmp/input.json' && 'Access to the container input file is blocked') ||
    (filePath.endsWith('.credentials.json') && 'Access to .credentials.json is blocked');

  if (reason) {
    return {
      hookSpecificOutput: {
        hookEventName: h.hook_event_name,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: `${reason} for security reasons.`,
      },
    };
  }

  return {};
};
