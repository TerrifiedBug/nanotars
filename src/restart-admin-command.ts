/**
 * Admin slash-command handler for `/restart` — restart all agent
 * containers. Async; awaits each restart sequentially so the operator
 * gets a single success/failure summary.
 *
 * Owner-only via command-gate (admin-only is too permissive for a
 * service-wide bounce). Returns a one-line summary.
 *
 * Does NOT restart the host node process itself — that requires
 * systemd/launchd which the chat command can't drive cleanly. For host
 * restart, operator runs `nanotars restart` on the shell.
 */
import { checkCommandPermission } from './command-gate.js';
import { logger } from './logger.js';
import { getAllAgentGroups } from './db/agent-groups.js';

export interface RestartAdminCommandArgs {
  command: string;
  userId: string | undefined;
  agentGroupId: string;
}

export interface RestartAdminCommandResult {
  handled: boolean;
  reply?: string;
  permissionReason?: string;
}

/** Deps the apply path needs at runtime. */
export interface RestartAdminDeps {
  /** Stop the active container for `folder` so the next inbound respawns. */
  restartGroup: (folder: string, reason: string) => Promise<void>;
}

let registeredDeps: RestartAdminDeps | undefined;

/** Wire the restart dep at boot from src/index.ts. */
export function registerRestartAdminDeps(deps: RestartAdminDeps): void {
  registeredDeps = deps;
}

export async function tryHandleRestartAdminCommand(
  args: RestartAdminCommandArgs,
): Promise<RestartAdminCommandResult> {
  if (args.command !== '/restart') {
    return { handled: false };
  }

  const decision = checkCommandPermission(args.userId, args.command, args.agentGroupId);
  if (!decision.allowed) {
    logger.warn(
      { command: args.command, userId: args.userId, reason: decision.reason },
      'Restart admin command denied by command-gate',
    );
    return {
      handled: true,
      reply: `Command ${args.command} is admin-only.`,
      permissionReason: decision.reason,
    };
  }

  if (!registeredDeps) {
    return {
      handled: true,
      reply: 'Restart unavailable — restart dependency not wired (boot configuration issue).',
      permissionReason: decision.reason,
    };
  }

  const groups = getAllAgentGroups();
  if (groups.length === 0) {
    return {
      handled: true,
      reply: 'No agent groups to restart.',
      permissionReason: decision.reason,
    };
  }

  const results: Array<{ folder: string; ok: boolean; error?: string }> = [];
  for (const ag of groups) {
    try {
      await registeredDeps.restartGroup(ag.folder, `admin /restart by ${args.userId}`);
      results.push({ folder: ag.folder, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ folder: ag.folder, ok: false, error: msg });
    }
  }

  const ok = results.filter((r) => r.ok).map((r) => r.folder);
  const failed = results.filter((r) => !r.ok);
  let reply = `Restarted ${ok.length}/${groups.length} groups.`;
  if (ok.length > 0) reply += `\n  ok: ${ok.join(', ')}`;
  if (failed.length > 0) {
    reply += `\n  failed: ${failed.map((f) => `${f.folder} (${f.error})`).join(', ')}`;
  }
  reply += '\n\nContainers will respawn on next inbound message.';

  logger.info({ by: args.userId, ok: ok.length, failed: failed.length }, '/restart applied');
  return { handled: true, reply, permissionReason: decision.reason };
}
