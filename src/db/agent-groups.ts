import crypto from 'crypto';
import { getDb } from './init.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from '../types.js';
import { logger } from '../logger.js';
import { isValidGroupFolder } from './state.js';

// --- Agent groups ---

export function getAgentGroupById(id: string): AgentGroup | undefined {
  return getDb()
    .prepare(`SELECT * FROM agent_groups WHERE id = ?`)
    .get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  if (!isValidGroupFolder(folder)) {
    logger.warn({ folder }, 'getAgentGroupByFolder rejected unsafe folder');
    return undefined;
  }
  return getDb()
    .prepare(`SELECT * FROM agent_groups WHERE folder = ?`)
    .get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  const rows = getDb()
    .prepare(`SELECT * FROM agent_groups ORDER BY created_at, id`)
    .all() as AgentGroup[];
  return rows.filter((r) => {
    if (!isValidGroupFolder(r.folder)) {
      logger.warn({ id: r.id, folder: r.folder }, 'Skipping agent group with invalid folder name');
      return false;
    }
    return true;
  });
}

export function createAgentGroup(args: {
  name: string;
  folder: string;
  container_config?: string | null;
  agent_provider?: string | null;
}): AgentGroup {
  if (!isValidGroupFolder(args.folder)) {
    throw new Error(`invalid folder: ${args.folder}`);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, container_config, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.name,
      args.folder,
      args.agent_provider ?? null,
      args.container_config ?? null,
      now,
    );
  return {
    id,
    name: args.name,
    folder: args.folder,
    agent_provider: args.agent_provider ?? null,
    container_config: args.container_config ?? null,
    created_at: now,
  };
}

// --- Messaging groups ---

export function getMessagingGroup(
  channel_type: string,
  platform_id: string,
): MessagingGroup | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM messaging_groups WHERE channel_type = ? AND platform_id = ?`,
    )
    .get(channel_type, platform_id) as MessagingGroup | undefined;
}

export function getMessagingGroupById(id: string): MessagingGroup | undefined {
  return getDb()
    .prepare(`SELECT * FROM messaging_groups WHERE id = ?`)
    .get(id) as MessagingGroup | undefined;
}

export function createMessagingGroup(args: {
  channel_type: string;
  platform_id: string;
  name?: string | null;
  is_group?: number;
  unknown_sender_policy?: 'strict' | 'request_approval' | 'public';
}): MessagingGroup {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const policy = args.unknown_sender_policy ?? 'public';
  const isGroup = args.is_group ?? 0;
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.channel_type,
      args.platform_id,
      args.name ?? null,
      isGroup,
      policy,
      now,
    );
  return {
    id,
    channel_type: args.channel_type,
    platform_id: args.platform_id,
    name: args.name ?? null,
    is_group: isGroup,
    unknown_sender_policy: policy,
    created_at: now,
  };
}

// --- Wiring (messaging_group_agents) ---

export function getWiringForMessagingGroup(
  messaging_group_id: string,
): MessagingGroupAgent[] {
  return getDb()
    .prepare(
      `SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? ORDER BY priority DESC, created_at, id`,
    )
    .all(messaging_group_id) as MessagingGroupAgent[];
}

export function getWiringForAgentGroup(
  agent_group_id: string,
): MessagingGroupAgent[] {
  return getDb()
    .prepare(
      `SELECT * FROM messaging_group_agents WHERE agent_group_id = ? ORDER BY priority DESC, created_at, id`,
    )
    .all(agent_group_id) as MessagingGroupAgent[];
}

export function getWiring(
  messaging_group_id: string,
  agent_group_id: string,
): MessagingGroupAgent | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?`,
    )
    .get(messaging_group_id, agent_group_id) as MessagingGroupAgent | undefined;
}

export function createWiring(args: {
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode?: 'pattern' | 'always' | 'mention-sticky';
  engage_pattern?: string | null;
  sender_scope?: 'all' | 'known';
  ignored_message_policy?: 'drop' | 'observe';
}): MessagingGroupAgent {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const engage_mode = args.engage_mode ?? 'pattern';
  const engage_pattern = args.engage_pattern ?? null;
  const sender_scope = args.sender_scope ?? 'all';
  const ignored_message_policy = args.ignored_message_policy ?? 'drop';
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
          sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'shared', 0, ?)`,
    )
    .run(
      id,
      args.messaging_group_id,
      args.agent_group_id,
      engage_mode,
      engage_pattern,
      sender_scope,
      ignored_message_policy,
      now,
    );
  return {
    id,
    messaging_group_id: args.messaging_group_id,
    agent_group_id: args.agent_group_id,
    engage_mode,
    engage_pattern,
    sender_scope,
    ignored_message_policy,
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  };
}

export function deleteWiring(
  messaging_group_id: string,
  agent_group_id: string,
): void {
  getDb()
    .prepare(
      `DELETE FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?`,
    )
    .run(messaging_group_id, agent_group_id);
}

// --- Convenience: legacy-compat lookup (used by router refactor in A3) ---

/**
 * Resolve all wiring rows for an inbound message keyed by (channel, platform_id).
 * Returns [] if no messaging group is registered. Each returned row carries the
 * resolved AgentGroup, MessagingGroupAgent, and MessagingGroup for routing
 * decisions.
 */
export function resolveAgentsForInbound(
  channel: string,
  platform_id: string,
): Array<{
  agentGroup: AgentGroup;
  wiring: MessagingGroupAgent;
  messagingGroup: MessagingGroup;
}> {
  const mg = getMessagingGroup(channel, platform_id);
  if (!mg) return [];
  const wirings = getWiringForMessagingGroup(mg.id);
  const out: Array<{
    agentGroup: AgentGroup;
    wiring: MessagingGroupAgent;
    messagingGroup: MessagingGroup;
  }> = [];
  for (const w of wirings) {
    const ag = getAgentGroupById(w.agent_group_id);
    if (!ag) continue;
    if (!isValidGroupFolder(ag.folder)) {
      logger.warn(
        { id: ag.id, folder: ag.folder },
        'resolveAgentsForInbound skipping agent group with invalid folder',
      );
      continue;
    }
    out.push({ agentGroup: ag, wiring: w, messagingGroup: mg });
  }
  return out;
}
