/**
 * Admin slash-command handler for `/health` — quick at-a-glance status
 * report. Mirrors the `nanotars-health` skill but as a single chat reply.
 *
 * Fast checks only (no shelling out to systemctl/docker — those are in the
 * skill). Reports DB row counts + plugin / channel registry state.
 */
import { getDb } from './db/init.js';
import { checkCommandPermission } from './command-gate.js';
import { logger } from './logger.js';
import { getAllAgentGroups } from './db/agent-groups.js';

export interface HealthAdminCommandArgs {
  command: string;
  userId: string | undefined;
  agentGroupId: string;
}

export interface HealthAdminCommandResult {
  handled: boolean;
  reply?: string;
  permissionReason?: string;
}

export function tryHandleHealthAdminCommand(
  args: HealthAdminCommandArgs,
): HealthAdminCommandResult {
  if (args.command !== '/health') {
    return { handled: false };
  }

  const decision = checkCommandPermission(args.userId, args.command, args.agentGroupId);
  if (!decision.allowed) {
    logger.warn(
      { command: args.command, userId: args.userId, reason: decision.reason },
      'Health admin command denied by command-gate',
    );
    return {
      handled: true,
      reply: `Command ${args.command} is admin-only.`,
      permissionReason: decision.reason,
    };
  }

  const lines: string[] = [];
  lines.push('*nanotars health*');

  // Process / uptime
  const uptimeSec = Math.floor(process.uptime());
  lines.push(`uptime: ${formatUptime(uptimeSec)} (pid ${process.pid})`);

  // DB
  try {
    const db = getDb();
    const userCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    const messageCount = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    const pendingApprovals = (
      db.prepare("SELECT COUNT(*) AS n FROM pending_approvals WHERE status='pending'").get() as {
        n: number;
      }
    ).n;
    lines.push(`db: ${userCount} users, ${messageCount} messages, ${pendingApprovals} pending approvals`);
  } catch (err) {
    lines.push(`db: ERROR — ${err instanceof Error ? err.message : String(err)}`);
  }

  // Agent groups
  try {
    const groups = getAllAgentGroups();
    lines.push(`agent groups: ${groups.length} (${groups.map((g) => g.folder).join(', ') || 'none'})`);
  } catch (err) {
    lines.push(`agent groups: ERROR — ${err instanceof Error ? err.message : String(err)}`);
  }

  lines.push('');
  lines.push('For deeper investigation: run `/nanotars-health` on the host.');

  return { handled: true, reply: lines.join('\n'), permissionReason: decision.reason };
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}
