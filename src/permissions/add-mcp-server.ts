/**
 * Phase 5C — host-side handler for the `add_mcp_server` IPC task emitted
 * by the container's `add_mcp_server` MCP tool.
 *
 * Mirrors `install-packages.ts` but with a tighter command-allowlist
 * (defense in depth: even a compromised agent container cannot wire an
 * arbitrary executable into its MCP config).
 *
 * Allowed commands (locked at spec time):
 *   - bare basenames: npx, node, python, python3, bash
 *   - absolute paths under /usr/local/bin/ or /workspace/
 *
 * Anything else is rejected with a notify-back that hints at the canonical
 * patterns the agent can use.
 *
 * Flow:
 *   1. Resolve the calling agent group from `groupFolder`.
 *   2. Validate name + command (host-side allowlist; container-side already
 *      enforced name/command non-empty).
 *   3. Call `requestApproval({ action: 'add_mcp_server', ... })`.
 *   4. On admin click, `applyDecision` (5C-04) writes
 *      `container_config.mcpServers[name] = { command, args, env }` and
 *      restarts the container so the new server loads on next spawn. No
 *      image rebuild — the agent-runner reads mcpServers at startup.
 *
 * Note: the command-allowlist is intentionally simple. A more capable
 * scheme (signature verification, file-checksum allowlist, …) is out of
 * scope; v1's threat model treats the host filesystem as trusted.
 */
import { getAgentGroupByFolder } from '../db/agent-groups.js';
import { logger } from '../logger.js';
import {
  notifyAgent,
  registerApprovalHandler,
  requestApproval,
} from './approval-primitive.js';

/**
 * Bare-basename commands the agent may use without specifying a path. The
 * host trusts that any binary on PATH inside the agent container is safe
 * (the image is host-built and the agent already runs arbitrary code).
 */
export const ALLOWED_COMMAND_BASES = new Set([
  'npx',
  'node',
  'python',
  'python3',
  'bash',
]);

/**
 * Path prefixes the agent may invoke with an absolute path. /usr/local/bin/
 * is the standard install location for binaries; /workspace/ lets the
 * agent invoke a server it built itself.
 */
export const ALLOWED_PATH_PREFIXES = ['/usr/local/bin/', '/workspace/'];

/** Returns true iff the command matches the allowlist. */
export function isCommandAllowed(cmd: string): boolean {
  if (ALLOWED_COMMAND_BASES.has(cmd)) return true;
  return ALLOWED_PATH_PREFIXES.some((prefix) => cmd.startsWith(prefix));
}

export interface AddMcpServerRequestTask {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  groupFolder: string;
}

/**
 * Process an `add_mcp_server` IPC task: validate + queue an approval card.
 *
 * Returns the resulting `approvalId` on success; undefined when dropped.
 */
export async function handleAddMcpServerRequest(
  task: AddMcpServerRequestTask,
  originatingChannel: string,
): Promise<string | undefined> {
  const ag = getAgentGroupByFolder(task.groupFolder);
  if (!ag) {
    logger.warn(
      { folder: task.groupFolder },
      'add_mcp_server dropped: agent group not found',
    );
    return undefined;
  }

  if (!task.name || !task.command) {
    notifyAgent(ag.id, 'add_mcp_server failed: name and command are required.');
    return undefined;
  }
  if (!isCommandAllowed(task.command)) {
    notifyAgent(
      ag.id,
      `add_mcp_server failed: command "${task.command}" not allowed. ` +
        'Use one of: npx, node, python, python3, bash, ' +
        'or an absolute path under /usr/local/bin/ or /workspace/.',
    );
    return undefined;
  }

  const result = await requestApproval({
    action: 'add_mcp_server',
    agentGroupId: ag.id,
    payload: {
      name: task.name,
      command: task.command,
      args: task.args ?? [],
      env: task.env ?? {},
    },
    originatingChannel,
  });

  logger.info(
    {
      approvalId: result.approvalId,
      agentGroupId: ag.id,
      mcpName: task.name,
      command: task.command,
      hasApprover: result.approvers.length > 0,
    },
    'add_mcp_server approval queued',
  );
  return result.approvalId;
}

/**
 * Register the `add_mcp_server` approval handler. 5C-03 wires only the
 * `render` half; 5C-04 adds `applyDecision` (mutate config + restart).
 */
export function registerAddMcpServerHandler(): void {
  registerApprovalHandler('add_mcp_server', {
    render({ payload }) {
      const name = (payload.name as string | undefined) ?? '<unknown>';
      const command = (payload.command as string | undefined) ?? '<unknown>';
      const args = (payload.args as string[] | undefined) ?? [];
      const argStr = args.length > 0 ? ` ${args.join(' ')}` : '';
      return {
        title: 'Add MCP Server Request',
        body:
          `Agent wants to wire MCP server "${name}":\n` +
          `Command: ${command}${argStr}`,
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      };
    },
    // applyDecision wired in 5C-04 (mutate mcpServers + restart).
  });
}
