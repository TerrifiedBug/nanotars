import fs from 'fs';
import path from 'path';

import type { AgentGroup, MessagingGroup } from './types.js';
import { getDb } from './db/init.js';
import { logger } from './logger.js';

export interface ChannelMigrationPluginUpdate {
  name: string;
  dir: string;
  fromChannels: string[];
  toChannels: string[];
}

export interface ChannelMigrationPluginWarning {
  name: string;
  dir: string;
  reason: string;
  channels: string[];
  groups: string[];
}

export interface ChannelMigrationPlan {
  group: {
    id: string;
    folder: string;
    name: string;
  };
  fromChannel: string;
  toChannel: string;
  sourceWirings: Array<{
    messaging_group_id: string;
    platform_id: string;
    name: string | null;
  }>;
  tasksToMove: number;
  pendingApprovalsToDelete: number;
  pendingQuestionsToDelete: number;
  userDmsToDelete: number;
  pluginScopeUpdates: ChannelMigrationPluginUpdate[];
  pluginScopeWarnings: ChannelMigrationPluginWarning[];
  groupEnvFile: string;
  groupEnvExists: boolean;
}

export interface ChannelMigrationApplyResult {
  plan: ChannelMigrationPlan;
  pluginScopesUpdated: ChannelMigrationPluginUpdate[];
  pluginScopeErrors: Array<{ name: string; dir: string; error: string }>;
}

export function planChannelMigration(args: {
  agentGroup: AgentGroup;
  fromChannel: string;
  toChannel: string;
  projectRoot?: string;
}): ChannelMigrationPlan {
  const projectRoot = args.projectRoot ?? process.cwd();
  const db = getDb();
  const sourceWirings = db
    .prepare(
      `
      SELECT mg.id AS messaging_group_id, mg.platform_id, mg.name
      FROM messaging_groups mg
      JOIN messaging_group_agents w ON w.messaging_group_id = mg.id
      WHERE mg.channel_type = ? AND w.agent_group_id = ?
      ORDER BY mg.created_at, mg.id
      `,
    )
    .all(args.fromChannel, args.agentGroup.id) as Array<{
    messaging_group_id: string;
    platform_id: string;
    name: string | null;
  }>;
  const oldIds = sourceWirings.map((row) => row.messaging_group_id);
  const oldPlatformIds = sourceWirings.map((row) => row.platform_id);

  const tasksToMove = oldPlatformIds.length
    ? scalarCount(
        `SELECT COUNT(*) FROM scheduled_tasks WHERE group_folder = ? AND chat_jid IN (${placeholders(oldPlatformIds)})`,
        args.agentGroup.folder,
        ...oldPlatformIds,
      )
    : 0;
  const pendingApprovalsToDelete = tableExists('pending_approvals')
    ? scalarCount(
        'SELECT COUNT(*) FROM pending_approvals WHERE agent_group_id = ? AND channel_type = ?',
        args.agentGroup.id,
        args.fromChannel,
      )
    : 0;
  const pendingQuestionsToDelete =
    tableExists('pending_questions') && oldPlatformIds.length
      ? scalarCount(
          `SELECT COUNT(*) FROM pending_questions WHERE channel_type = ? AND platform_id IN (${placeholders(oldPlatformIds)})`,
          args.fromChannel,
          ...oldPlatformIds,
        )
      : 0;
  const userDmsToDelete =
    tableExists('user_dms') && oldIds.length
      ? scalarCount(
          `SELECT COUNT(*) FROM user_dms WHERE messaging_group_id IN (${placeholders(oldIds)})`,
          ...oldIds,
        )
      : 0;
  const pluginScope = planPluginScopeUpdates({
    projectRoot,
    folder: args.agentGroup.folder,
    fromChannel: args.fromChannel,
    toChannel: args.toChannel,
  });
  const groupEnvFile = path.join(
    projectRoot,
    'groups',
    args.agentGroup.folder,
    '.env',
  );

  return {
    group: {
      id: args.agentGroup.id,
      folder: args.agentGroup.folder,
      name: args.agentGroup.name,
    },
    fromChannel: args.fromChannel,
    toChannel: args.toChannel,
    sourceWirings,
    tasksToMove,
    pendingApprovalsToDelete,
    pendingQuestionsToDelete,
    userDmsToDelete,
    pluginScopeUpdates: pluginScope.updates,
    pluginScopeWarnings: pluginScope.warnings,
    groupEnvFile,
    groupEnvExists: fs.existsSync(groupEnvFile),
  };
}

export function applyChannelMigration(args: {
  agentGroup: AgentGroup;
  fromChannel: string;
  newMessagingGroup: MessagingGroup;
  projectRoot?: string;
}): ChannelMigrationApplyResult {
  if (args.fromChannel === args.newMessagingGroup.channel_type) {
    throw new Error(
      `migrate_channel destination matches source channel: ${args.fromChannel}`,
    );
  }

  const projectRoot = args.projectRoot ?? process.cwd();
  const plan = planChannelMigration({
    agentGroup: args.agentGroup,
    fromChannel: args.fromChannel,
    toChannel: args.newMessagingGroup.channel_type,
    projectRoot,
  });
  if (plan.sourceWirings.length === 0) {
    return { plan, pluginScopesUpdated: [], pluginScopeErrors: [] };
  }

  const oldIds = plan.sourceWirings.map((row) => row.messaging_group_id);
  const oldPlatformIds = plan.sourceWirings.map((row) => row.platform_id);
  const db = getDb();
  const tx = db.transaction(() => {
    if (oldPlatformIds.length > 0) {
      db.prepare(
        `UPDATE scheduled_tasks
         SET chat_jid = ?
         WHERE group_folder = ? AND chat_jid IN (${placeholders(oldPlatformIds)})`,
      ).run(
        args.newMessagingGroup.platform_id,
        args.agentGroup.folder,
        ...oldPlatformIds,
      );
    }

    if (oldIds.length > 0) {
      for (const table of [
        'pending_channel_approvals',
        'pending_sender_approvals',
        'user_dms',
      ]) {
        if (tableExists(table)) {
          db.prepare(
            `DELETE FROM ${table} WHERE messaging_group_id IN (${placeholders(oldIds)})`,
          ).run(...oldIds);
        }
      }
      if (tableExists('pending_approvals')) {
        db.prepare(
          `DELETE FROM pending_approvals
           WHERE agent_group_id = ? AND channel_type = ?`,
        ).run(args.agentGroup.id, args.fromChannel);
      }
      if (tableExists('pending_questions') && oldPlatformIds.length > 0) {
        db.prepare(
          `DELETE FROM pending_questions
           WHERE channel_type = ? AND platform_id IN (${placeholders(oldPlatformIds)})`,
        ).run(args.fromChannel, ...oldPlatformIds);
      }
      db.prepare(
        `DELETE FROM messaging_group_agents
         WHERE agent_group_id = ? AND messaging_group_id IN (${placeholders(oldIds)})`,
      ).run(args.agentGroup.id, ...oldIds);
      db.prepare(
        `DELETE FROM messaging_groups
         WHERE id IN (${placeholders(oldIds)})
           AND NOT EXISTS (
             SELECT 1 FROM messaging_group_agents w
             WHERE w.messaging_group_id = messaging_groups.id
           )`,
      ).run(...oldIds);
    }
  });
  tx();

  const pluginResult = applyPluginScopeUpdates(plan.pluginScopeUpdates);
  if (pluginResult.errors.length > 0) {
    logger.warn(
      { errors: pluginResult.errors, folder: args.agentGroup.folder },
      'Channel migration completed but some plugin scope updates failed',
    );
  }

  logger.info(
    {
      agent_group_id: args.agentGroup.id,
      folder: args.agentGroup.folder,
      fromChannel: args.fromChannel,
      toChannel: args.newMessagingGroup.channel_type,
      oldMessagingGroups: oldIds.length,
      tasksMoved: plan.tasksToMove,
      pluginScopesUpdated: pluginResult.updated.length,
    },
    'migrate_channel pairing consumed; old channel bindings removed',
  );

  return {
    plan,
    pluginScopesUpdated: pluginResult.updated,
    pluginScopeErrors: pluginResult.errors,
  };
}

function planPluginScopeUpdates(args: {
  projectRoot: string;
  folder: string;
  fromChannel: string;
  toChannel: string;
}): {
  updates: ChannelMigrationPluginUpdate[];
  warnings: ChannelMigrationPluginWarning[];
} {
  const updates: ChannelMigrationPluginUpdate[] = [];
  const warnings: ChannelMigrationPluginWarning[] = [];
  const pluginsDir = path.join(args.projectRoot, 'plugins');
  if (!fs.existsSync(pluginsDir)) return { updates, warnings };

  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'channels') continue;
    const dir = path.join(pluginsDir, entry.name);
    const manifestPath = path.join(dir, 'plugin.json');
    const manifest = readManifest(manifestPath);
    if (!manifest) continue;

    const name = typeof manifest.name === 'string' ? manifest.name : entry.name;
    const channels = stringArray(manifest.channels, ['*']);
    const groups = stringArray(manifest.groups, ['*']);
    if (channels.includes('*') || !channels.includes(args.fromChannel))
      continue;
    if (!groups.includes(args.folder) && !groups.includes('*')) continue;

    if (groups.length === 1 && groups[0] === args.folder) {
      const toChannels = uniqueSorted(
        channels.map((channel) =>
          channel === args.fromChannel ? args.toChannel : channel,
        ),
      );
      updates.push({ name, dir, fromChannels: channels, toChannels });
    } else {
      warnings.push({
        name,
        dir,
        channels,
        groups,
        reason:
          'plugin scope covers this group and other groups; one manifest cannot express per-group channel migration safely',
      });
    }
  }
  return { updates, warnings };
}

function applyPluginScopeUpdates(updates: ChannelMigrationPluginUpdate[]): {
  updated: ChannelMigrationPluginUpdate[];
  errors: Array<{ name: string; dir: string; error: string }>;
} {
  const updated: ChannelMigrationPluginUpdate[] = [];
  const errors: Array<{ name: string; dir: string; error: string }> = [];
  for (const update of updates) {
    const manifestPath = path.join(update.dir, 'plugin.json');
    try {
      const manifest = readManifest(manifestPath);
      if (!manifest) throw new Error('plugin.json could not be parsed');
      manifest.channels = update.toChannels;
      writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      updated.push(update);
    } catch (err) {
      errors.push({
        name: update.name,
        dir: update.dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { updated, errors };
}

function readManifest(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  return strings.length > 0 ? strings : fallback;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(',');
}

function tableExists(name: string): boolean {
  const row = getDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return !!row;
}

function scalarCount(sql: string, ...args: unknown[]): number {
  const row = getDb()
    .prepare(sql)
    .get(...args) as Record<string, number> | undefined;
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
}
