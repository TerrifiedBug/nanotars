/**
 * Phase 5B — admin slash-command handler for `/rebuild-image`.
 *
 * Mirrors the 5D `tryHandleLifecycleAdminCommand` pattern: v1-archive does
 * not yet ship a centralised host-side slash-command dispatcher (the
 * `command-gate.ts` registry exists but actual command interpretation still
 * lives in the agent). This module sits between the gate and
 * `buildAgentGroupImage` so a future dispatcher can wire it in with one
 * import:
 *
 *   const result = await tryHandleRebuildImageAdminCommand({
 *     command, args, userId, agentGroupId,
 *   });
 *   if (result.handled) return reply(result.reply!);
 *
 * Returns `{ handled: false }` when the command isn't `/rebuild-image`.
 * Permission gating is delegated to `checkCommandPermission` from
 * command-gate so the same owner / global-admin / scoped-admin precedence
 * applies as for `/pause` / `/resume`.
 */
import { checkCommandPermission } from './command-gate.js';
import { buildAgentGroupImage } from './container-runner.js';
import { logger } from './logger.js';

export interface RebuildImageAdminCommandArgs {
  /** First whitespace-delimited token from the user's message (e.g. "/rebuild-image"). */
  command: string;
  /**
   * Remaining whitespace-delimited tokens from the message. The first
   * positional argument is the target agent group id. Pass [] when the
   * caller doesn't have parsed args; the handler will reply with usage.
   */
  args: string[];
  /**
   * Resolved user id of the message sender. Pass `undefined` for legacy
   * paths that have not yet threaded a sender; the call will be denied.
   */
  userId: string | undefined;
  /**
   * Agent group context for permission gating. Scoped admins can only
   * rebuild images for groups they administer; the target id (`args[0]`)
   * may differ when an owner / global admin issues the command from one
   * group to rebuild another.
   */
  agentGroupId: string;
}

export interface RebuildImageAdminCommandResult {
  handled: boolean;
  /** Reply text to send back to the user. Present when handled === true. */
  reply?: string;
  /** Decision reason from command-gate (e.g. 'owner', 'admin-only'). */
  permissionReason?: string;
  /** Resolved image tag on a successful rebuild. */
  imageTag?: string;
}

export async function tryHandleRebuildImageAdminCommand(
  argsIn: RebuildImageAdminCommandArgs,
): Promise<RebuildImageAdminCommandResult> {
  const cmd = argsIn.command;
  if (cmd !== '/rebuild-image') {
    return { handled: false };
  }

  const decision = checkCommandPermission(argsIn.userId, cmd, argsIn.agentGroupId);
  if (!decision.allowed) {
    logger.warn(
      {
        command: cmd,
        userId: argsIn.userId,
        agentGroupId: argsIn.agentGroupId,
        reason: decision.reason,
      },
      'Rebuild-image admin command denied by command-gate',
    );
    return {
      handled: true,
      reply: `Command ${cmd} is admin-only.`,
      permissionReason: decision.reason,
    };
  }

  const targetId = argsIn.args[0];
  if (!targetId) {
    return {
      handled: true,
      reply: 'Usage: /rebuild-image <agent-group-id>',
      permissionReason: decision.reason,
    };
  }

  try {
    const tag = await buildAgentGroupImage(targetId);
    logger.info(
      { command: cmd, userId: argsIn.userId, targetId, tag },
      'Per-agent-group image rebuilt via /rebuild-image',
    );
    return {
      handled: true,
      reply: `Image rebuilt: ${tag}`,
      permissionReason: decision.reason,
      imageTag: tag,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { command: cmd, userId: argsIn.userId, targetId, err: msg },
      'Per-agent-group image rebuild failed',
    );
    return {
      handled: true,
      reply: `Rebuild failed: ${msg}`,
      permissionReason: decision.reason,
    };
  }
}
