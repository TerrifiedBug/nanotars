import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import {
  planChannelMigration,
  type ChannelMigrationPlan,
} from '../../channel-migration.js';
import {
  createAgentGroup,
  getAllAgentGroups,
  getAllSynthesizedGroupRows,
} from '../../db/agent-groups.js';
import { getDb } from '../../db/init.js';
import { getAllTasks, getTaskById, getTasksForGroup } from '../../db/tasks.js';
import { initGroupFilesystem } from '../../group-init.js';
import { createPendingCode } from '../../pending-codes.js';
import { grantRole, revokeRole } from '../../permissions/user-roles.js';
import { ScheduledTask } from '../../types.js';
import {
  hasFlag,
  initCliDatabase,
  parseGlobalFlags,
  printJson,
} from './common.js';

export async function groupsCommand(args: string[]): Promise<number> {
  const { json, rest } = parseGlobalFlags(args);
  const [subcommand, ...subArgs] = rest;
  initCliDatabase();

  switch (subcommand ?? 'list') {
    case 'create':
      return createGroup(subArgs);
    case 'list':
      return listGroups(json);
    case 'show':
      return showGroup(subArgs, json);
    case 'register-code':
      return registerCode(subArgs);
    case 'migrate-code':
      return migrateCode(subArgs, json);
    case 'delete':
      return deleteGroup(subArgs);
    case '-h':
    case '--help':
    case 'help':
      groupsHelp();
      return 0;
    default:
      process.stderr.write(`groups: unknown command '${subcommand}'\n\n`);
      groupsHelp(process.stderr);
      return 64;
  }
}

export async function channelsCommand(
  args: string[],
  projectRoot: string,
): Promise<number> {
  const { json, rest } = parseGlobalFlags(args);
  const [subcommand, ...subArgs] = rest;

  switch (subcommand ?? 'list') {
    case 'list':
      return listChannels(projectRoot, json);
    case 'clone':
    case 'add-instance':
      return cloneChannel(subArgs, projectRoot);
    case 'auth':
      process.stderr.write('channels auth: use `nanotars auth <channel>`\n');
      return 64;
    case 'remove':
      return removePlugin(['--channel', ...subArgs], projectRoot);
    case '-h':
    case '--help':
    case 'help':
      channelsHelp();
      return 0;
    default:
      process.stderr.write(`channels: unknown command '${subcommand}'\n\n`);
      channelsHelp(process.stderr);
      return 64;
  }
}

export async function pluginsCommand(
  args: string[],
  projectRoot: string,
): Promise<number> {
  const { json, rest } = parseGlobalFlags(args);
  const [subcommand, ...subArgs] = rest;
  switch (subcommand ?? 'list') {
    case 'list':
      return listPlugins(projectRoot, json);
    case 'inspect':
    case 'show':
      return inspectPlugin(subArgs, projectRoot, json);
    case 'remove':
      return removePlugin(subArgs, projectRoot);
    case '-h':
    case '--help':
    case 'help':
      pluginsHelp();
      return 0;
    default:
      process.stderr.write(`plugins: unknown command '${subcommand}'\n\n`);
      pluginsHelp(process.stderr);
      return 64;
  }
}

export async function agentsCommand(
  args: string[],
  projectRoot: string,
): Promise<number> {
  const { json, rest } = parseGlobalFlags(args);
  const [subcommand, ...subArgs] = rest;
  initCliDatabase();
  switch (subcommand ?? 'list') {
    case 'list':
      return listAgents(subArgs, projectRoot, json);
    case 'templates':
      return listAgentTemplates(projectRoot, json);
    case 'add':
      return addAgent(subArgs, projectRoot);
    case 'remove':
      return removeAgent(subArgs, projectRoot);
    case '-h':
    case '--help':
    case 'help':
      agentsHelp();
      return 0;
    default:
      process.stderr.write(`agents: unknown command '${subcommand}'\n\n`);
      agentsHelp(process.stderr);
      return 64;
  }
}

export async function tasksCommand(args: string[]): Promise<number> {
  const { json, rest } = parseGlobalFlags(args);
  const [subcommand, ...subArgs] = rest;
  initCliDatabase();
  switch (subcommand ?? 'list') {
    case 'list':
      return listTasks(subArgs, json);
    case 'cancel':
      return cancelTask(subArgs);
    case '-h':
    case '--help':
    case 'help':
      tasksHelp();
      return 0;
    default:
      process.stderr.write(`tasks: unknown command '${subcommand}'\n\n`);
      tasksHelp(process.stderr);
      return 64;
  }
}

export async function usersCommand(args: string[]): Promise<number> {
  const { json, rest } = parseGlobalFlags(args);
  const [subcommand, ...subArgs] = rest;
  initCliDatabase();
  switch (subcommand ?? 'list') {
    case 'list':
      return listUsers(subArgs, json);
    case 'grant':
      return grantOrRevokeUser('grant', subArgs);
    case 'revoke':
      return grantOrRevokeUser('revoke', subArgs);
    case '-h':
    case '--help':
    case 'help':
      usersHelp();
      return 0;
    default:
      process.stderr.write(`users: unknown command '${subcommand}'\n\n`);
      usersHelp(process.stderr);
      return 64;
  }
}

function listGroups(json: boolean): number {
  const groups = getAllAgentGroups();
  const wirings = getAllSynthesizedGroupRows();
  const rows = groups.map((group) => ({
    id: group.id,
    folder: group.folder,
    name: group.name,
    provider: group.agent_provider,
    created_at: group.created_at,
    wirings: wirings
      .filter((w) => w.agent_group_id === group.id)
      .map((w) => ({
        channel: w.channel_type,
        platform_id: w.platform_id,
        engage_mode: w.wiring_engage_mode,
        engage_pattern: w.wiring_engage_pattern,
        sender_scope: w.wiring_sender_scope,
        ignored_message_policy: w.wiring_ignored_message_policy,
        priority: w.wiring_priority,
      })),
  }));
  if (json) {
    printJson(rows);
    return 0;
  }
  for (const group of rows) {
    process.stdout.write(`${group.folder} (${group.name})\n`);
    if (group.wirings.length === 0) {
      process.stdout.write('  (unwired)\n');
    } else {
      for (const wiring of group.wirings) {
        process.stdout.write(
          `  ${wiring.channel} ${wiring.platform_id} engage=${wiring.engage_mode} scope=${wiring.sender_scope}\n`,
        );
      }
    }
  }
  return 0;
}

function showGroup(args: string[], json: boolean): number {
  const folder = args[0];
  if (!folder) {
    process.stderr.write('groups show: missing folder\n');
    return 64;
  }
  const group = getAllAgentGroups().find((g) => g.folder === folder);
  if (!group) {
    process.stderr.write(`groups show: group not found: ${folder}\n`);
    return 1;
  }
  const wirings = getAllSynthesizedGroupRows().filter(
    (w) => w.agent_group_id === group.id,
  );
  const tasks = getTasksForGroup(folder);
  const agentsDir = path.join(process.cwd(), 'groups', folder, 'agents');
  const agents = fs.existsSync(agentsDir)
    ? fs
        .readdirSync(agentsDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            fs.existsSync(path.join(agentsDir, entry.name, 'agent.json')),
        )
        .map((entry) => entry.name)
    : [];
  const result = { group, wirings, tasks, agents };
  if (json) {
    printJson(result);
    return 0;
  }
  process.stdout.write(`${group.folder} (${group.name}) id=${group.id}\n`);
  process.stdout.write(`wirings: ${wirings.length}\n`);
  for (const w of wirings)
    process.stdout.write(`  ${w.channel_type} ${w.platform_id}\n`);
  process.stdout.write(`tasks: ${tasks.length}\n`);
  process.stdout.write(
    `agents: ${agents.length ? agents.join(', ') : '(none)'}\n`,
  );
  return 0;
}

function createGroup(args: string[]): number {
  const folder = args[0];
  if (!folder) {
    process.stderr.write(
      'groups create: usage: nanotars groups create <folder> [--name <name>] [--instructions <text>] --apply\n',
    );
    return 64;
  }
  if (!isSafeName(folder)) {
    process.stderr.write(
      `groups create: invalid folder '${folder}' (use letters, numbers, dash, or underscore)\n`,
    );
    return 64;
  }
  const existing = getAllAgentGroups().find((g) => g.folder === folder);
  if (existing) {
    process.stderr.write(`groups create: group already exists: ${folder}\n`);
    return 1;
  }
  const name = readOption(args, '--name') ?? capitalise(folder);
  const instructions = readOption(args, '--instructions');
  const provider = readOption(args, '--provider') ?? 'claude';

  process.stdout.write(`group: ${folder} (${name})\n`);
  process.stdout.write(`provider: ${provider}\n`);
  process.stdout.write(`directory: ${path.join(process.cwd(), 'groups', folder)}\n`);
  if (!hasFlag(args, '--apply')) {
    process.stdout.write('dry-run: pass --apply to create the group\n');
    return 0;
  }

  try {
    const group = createAgentGroup({
      name,
      folder,
      agent_provider: provider,
    });
    initGroupFilesystem(group, { instructions });
    process.stdout.write(`created group: ${folder}\n`);
    process.stdout.write(
      `run \`nanotars groups register-code ${folder}\` to pair a chat\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `groups create: failed to create group '${folder}': ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function registerCode(args: string[]): Promise<number> {
  const folder = args[0];
  if (!folder) {
    process.stderr.write('groups register-code: missing folder\n');
    return 64;
  }
  let group = getAllAgentGroups().find((g) => g.folder === folder);
  if (!group) {
    try {
      group = createAgentGroup({ name: capitalise(folder), folder });
      initGroupFilesystem(group, {});
      process.stdout.write(`Created agent group: ${folder}\n`);
    } catch (err) {
      process.stderr.write(
        `groups register-code: failed to create group '${folder}': ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }
  const result = await createPendingCode({
    channel: 'any',
    intent: { kind: 'agent_group', target: group.id },
  });
  process.stdout.write(`Pairing code: ${result.code}\n`);
  process.stdout.write(
    `Send these 4 digits from the chat to wire to group '${folder}'.\n`,
  );
  process.stdout.write(`Code expires: ${result.expires_at ?? 'never'}\n`);
  return 0;
}

async function migrateCode(args: string[], json: boolean): Promise<number> {
  const folder = args[0];
  if (!folder) {
    process.stderr.write('groups migrate-code: missing folder\n');
    return 64;
  }
  const fromChannel = readOption(args, '--from-channel');
  const toChannel = readOption(args, '--to-channel');
  if (!fromChannel || !toChannel) {
    process.stderr.write(
      'groups migrate-code: usage: nanotars groups migrate-code <folder> --from-channel <name> --to-channel <name>\n',
    );
    return 64;
  }
  if (fromChannel === toChannel) {
    process.stderr.write(
      'groups migrate-code: source and destination channels must differ\n',
    );
    return 64;
  }
  if (!channelPluginExists(process.cwd(), toChannel)) {
    process.stderr.write(
      `groups migrate-code: destination channel plugin not installed: ${toChannel}\n`,
    );
    return 1;
  }
  const group = getAllAgentGroups().find((g) => g.folder === folder);
  if (!group) {
    process.stderr.write(`groups migrate-code: group not found: ${folder}\n`);
    return 1;
  }
  const plan = planChannelMigration({
    agentGroup: group,
    fromChannel,
    toChannel,
    projectRoot: process.cwd(),
  });
  if (plan.sourceWirings.length === 0) {
    process.stderr.write(
      `groups migrate-code: group '${folder}' has no wiring on channel '${fromChannel}'\n`,
    );
    return 1;
  }
  if (json && !hasFlag(args, '--apply')) {
    printJson(plan);
    return 0;
  }
  if (!json) printChannelMigrationPlan(plan);
  if (!hasFlag(args, '--apply')) {
    process.stdout.write(
      'dry-run: pass --apply to allocate a destination-channel migration pairing code\n',
    );
    return 0;
  }
  backupDatabase(process.cwd());
  const result = await createPendingCode({
    channel: toChannel,
    intent: {
      kind: 'migrate_channel',
      target: group.id,
      from_channel: fromChannel,
    },
  });
  if (json) {
    printJson({ code: result.code, expires_at: result.expires_at, plan });
    return 0;
  }
  process.stdout.write(`Migration pairing code: ${result.code}\n`);
  process.stdout.write(
    `Send these 4 digits from the destination ${toChannel} chat to move '${folder}' off ${fromChannel}.\n`,
  );
  process.stdout.write(
    'When claimed, NanoTars will wire the existing group folder to the new chat, move scheduled tasks to the new chat id, update safe plugin channel scopes, and remove old source-channel bindings.\n',
  );
  process.stdout.write(
    'After the destination chat confirms the claim, run `nanotars restart` so updated plugin channel scopes are loaded into new containers.\n',
  );
  process.stdout.write(`Code expires: ${result.expires_at ?? 'never'}\n`);
  return 0;
}

function printChannelMigrationPlan(plan: ChannelMigrationPlan): void {
  process.stdout.write(`group: ${plan.group.folder} (${plan.group.name})\n`);
  process.stdout.write(`source channel: ${plan.fromChannel}\n`);
  process.stdout.write(`destination channel: ${plan.toChannel}\n`);
  process.stdout.write(
    `source wirings to remove after destination claim: ${plan.sourceWirings.length}\n`,
  );
  for (const row of plan.sourceWirings) {
    process.stdout.write(
      `  ${row.platform_id}${row.name ? ` (${row.name})` : ''}\n`,
    );
  }
  process.stdout.write(`scheduled tasks to move: ${plan.tasksToMove}\n`);
  process.stdout.write(
    `pending approvals to delete: ${plan.pendingApprovalsToDelete}\n`,
  );
  process.stdout.write(
    `pending questions to delete: ${plan.pendingQuestionsToDelete}\n`,
  );
  process.stdout.write(
    `old-channel user DM bindings to delete: ${plan.userDmsToDelete}\n`,
  );
  process.stdout.write(
    `group env file preserved: ${plan.groupEnvExists ? plan.groupEnvFile : '(none)'}\n`,
  );
  process.stdout.write(
    `plugin channel scopes to update on claim: ${plan.pluginScopeUpdates.length}\n`,
  );
  for (const update of plan.pluginScopeUpdates) {
    process.stdout.write(
      `  ${update.name}: channels ${update.fromChannels.join(',')} -> ${update.toChannels.join(',')}\n`,
    );
  }
  if (plan.pluginScopeWarnings.length > 0) {
    process.stdout.write('plugin scopes needing manual review:\n');
    for (const warning of plan.pluginScopeWarnings) {
      process.stdout.write(
        `  ${warning.name}: channels=${warning.channels.join(',')} groups=${warning.groups.join(',')} - ${warning.reason}\n`,
      );
    }
  }
}

function deleteGroup(args: string[]): number {
  const folder = args[0];
  if (!folder) {
    process.stderr.write('groups delete: missing folder\n');
    return 64;
  }
  const group = getAllAgentGroups().find((g) => g.folder === folder);
  if (!group) {
    process.stderr.write(`groups delete: group not found: ${folder}\n`);
    return 1;
  }
  const db = getDb();
  const messagingGroups = db
    .prepare(
      `
      SELECT mg.id, mg.channel_type, mg.platform_id
      FROM messaging_groups mg
      JOIN messaging_group_agents w ON w.messaging_group_id = mg.id
      WHERE w.agent_group_id = ?
      `,
    )
    .all(group.id) as Array<{
    id: string;
    channel_type: string;
    platform_id: string;
  }>;
  const tasks = getTasksForGroup(folder);
  const scopedRoles = scalarCount(
    'SELECT COUNT(*) FROM user_roles WHERE agent_group_id = ?',
    group.id,
  );
  const members = scalarCount(
    'SELECT COUNT(*) FROM agent_group_members WHERE agent_group_id = ?',
    group.id,
  );
  const approvals = tableExists('pending_approvals')
    ? scalarCount(
        'SELECT COUNT(*) FROM pending_approvals WHERE agent_group_id = ?',
        group.id,
      )
    : 0;

  process.stdout.write(`group: ${folder} (${group.name})\n`);
  process.stdout.write(`wirings to remove: ${messagingGroups.length}\n`);
  for (const row of messagingGroups)
    process.stdout.write(`  ${row.channel_type} ${row.platform_id}\n`);
  process.stdout.write(`scheduled tasks to delete: ${tasks.length}\n`);
  process.stdout.write(`scoped roles to delete: ${scopedRoles}\n`);
  process.stdout.write(`memberships to delete: ${members}\n`);
  process.stdout.write(`pending approvals to delete: ${approvals}\n`);
  process.stdout.write(
    `preserved directory: ${path.join(process.cwd(), 'groups', folder)}\n`,
  );

  if (!hasFlag(args, '--apply')) {
    process.stdout.write(
      'dry-run: pass --apply to delete database rows. Group files are preserved.\n',
    );
    return 0;
  }

  backupDatabase(process.cwd());
  const ids = messagingGroups.map((row) => row.id);
  const tx = db.transaction(() => {
    if (tableExists('task_run_logs')) {
      db.prepare(
        `DELETE FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?)`,
      ).run(folder);
    }
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
    db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(folder);
    db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(group.id);
    db.prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?').run(
      group.id,
    );
    if (tableExists('pending_approvals'))
      db.prepare('DELETE FROM pending_approvals WHERE agent_group_id = ?').run(
        group.id,
      );
    if (tableExists('pending_sender_approvals'))
      db.prepare(
        'DELETE FROM pending_sender_approvals WHERE agent_group_id = ?',
      ).run(group.id);
    if (tableExists('pending_channel_approvals'))
      db.prepare(
        'DELETE FROM pending_channel_approvals WHERE agent_group_id = ?',
      ).run(group.id);
    db.prepare(
      'DELETE FROM messaging_group_agents WHERE agent_group_id = ?',
    ).run(group.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM messaging_groups
         WHERE id IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM messaging_group_agents w
             WHERE w.messaging_group_id = messaging_groups.id
           )`,
      ).run(...ids);
    }
    db.prepare('DELETE FROM agent_groups WHERE id = ?').run(group.id);
  });
  tx();
  process.stdout.write(`deleted group database rows for: ${folder}\n`);
  process.stdout.write('group directory preserved on disk\n');
  return 0;
}

function listChannels(projectRoot: string, json: boolean): number {
  initCliDatabase();
  const channelsDir = path.join(projectRoot, 'plugins', 'channels');
  const manifests = readPluginManifests(channelsDir, true);
  const rows = manifests.map((plugin) => ({
    ...plugin,
    hasAuthScript: fs.existsSync(path.join(plugin.dir, 'auth.js')),
    authStatus: channelAuthStatus(projectRoot, plugin.name),
    registeredChats: getDb()
      .prepare(
        'SELECT COUNT(*) AS count FROM messaging_groups WHERE channel_type = ?',
      )
      .get(plugin.name) as { count: number },
  }));
  if (json) {
    printJson(rows);
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.name} version=${row.version ?? 'unknown'} auth=${row.authStatus} auth.js=${row.hasAuthScript ? 'yes' : 'no'} chats=${row.registeredChats.count}\n`,
    );
  }
  if (rows.length === 0) process.stdout.write('(none)\n');
  return 0;
}

function cloneChannel(args: string[], projectRoot: string): number {
  const sourceName = args[0];
  const instanceName = args[1];
  if (!sourceName || !instanceName) {
    process.stderr.write(
      'channels clone: usage: nanotars channels clone <source-channel> <new-channel> [--token-env <KEY>] [--pool-env <KEY>] [--jid-prefix <prefix>] [--no-install] [--replace] --apply\n',
    );
    return 64;
  }
  if (!isSafeName(instanceName)) {
    process.stderr.write(
      `channels clone: invalid channel name '${instanceName}' (use letters, numbers, dash, or underscore)\n`,
    );
    return 64;
  }
  if (sourceName === instanceName) {
    process.stderr.write('channels clone: source and destination must differ\n');
    return 64;
  }

  const source = resolvePlugin(projectRoot, sourceName, true);
  if (!source) {
    process.stderr.write(`channels clone: source channel not found: ${sourceName}\n`);
    return 1;
  }
  const destDir = path.join(projectRoot, 'plugins', 'channels', instanceName);
  const destManifestPath = path.join(destDir, 'plugin.json');
  const existing = channelPluginExists(projectRoot, instanceName);
  if ((existing || fs.existsSync(destDir)) && !hasFlag(args, '--replace')) {
    process.stderr.write(
      `channels clone: destination already exists: ${instanceName} (pass --replace to overwrite)\n`,
    );
    return 1;
  }

  const tokenEnv = readOption(args, '--token-env') ?? defaultChannelTokenEnv(instanceName);
  const poolEnv = readOption(args, '--pool-env') ?? defaultChannelPoolEnv(instanceName);
  const jidPrefix = readOption(args, '--jid-prefix');
  const shouldInstall = !hasFlag(args, '--no-install');
  const manifest = prepareClonedChannelManifest(source.manifest, {
    instanceName,
    tokenEnv,
    poolEnv,
    jidPrefix,
  });

  process.stdout.write(`source: ${source.name}\n`);
  process.stdout.write(`destination: ${instanceName}\n`);
  process.stdout.write(`directory: ${destDir}\n`);
  process.stdout.write(
    `token env: ${tokenEnv}${manifest.containerEnvVars?.includes(tokenEnv) ? '' : ' (not declared in containerEnvVars)'}\n`,
  );
  if (manifest.telegramBotPoolEnv) process.stdout.write(`pool env: ${poolEnv}\n`);
  if (manifest.telegramJidPrefix) process.stdout.write(`jid prefix: ${manifest.telegramJidPrefix}\n`);
  process.stdout.write(`install dependencies: ${shouldInstall ? 'yes' : 'no'}\n`);

  if (!hasFlag(args, '--apply')) {
    process.stdout.write('dry-run: pass --apply to create the channel instance\n');
    return 0;
  }

  try {
    fs.rmSync(destDir, { recursive: true, force: true });
    copyDir(source.dir, destDir, { skip: new Set(['node_modules']) });
    writeFileAtomic(destManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (shouldInstall && fs.existsSync(path.join(destDir, 'package.json'))) {
      const install = spawnSync('npm', ['install'], {
        cwd: destDir,
        stdio: 'inherit',
      });
      if (install.error) throw install.error;
      if ((install.status ?? 0) !== 0) {
        process.stderr.write(
          `channels clone: npm install failed in ${destDir}\n`,
        );
        return install.status ?? 1;
      }
    }
  } catch (err) {
    process.stderr.write(
      `channels clone: failed to create '${instanceName}': ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stdout.write(`created channel instance: ${instanceName}\n`);
  process.stdout.write(`run \`nanotars auth ${instanceName}\` to authenticate it\n`);
  process.stdout.write('run `nanotars restart` to load the new channel\n');
  return 0;
}

function channelPluginExists(projectRoot: string, channel: string): boolean {
  const manifestPath = path.join(
    projectRoot,
    'plugins',
    'channels',
    channel,
    'plugin.json',
  );
  if (!fs.existsSync(manifestPath)) return false;
  const manifest = readJson(manifestPath);
  return manifest.channelPlugin === true || manifest.type === 'channel';
}

function listPlugins(projectRoot: string, json: boolean): number {
  const skillPlugins = readPluginManifests(
    path.join(projectRoot, 'plugins'),
    false,
  ).filter((plugin) => !plugin.dir.includes(`${path.sep}channels${path.sep}`));
  const channelPlugins = readPluginManifests(
    path.join(projectRoot, 'plugins', 'channels'),
    true,
  );
  const rows = [...skillPlugins, ...channelPlugins].map((plugin) => ({
    ...plugin,
    channels: plugin.manifest.channels ?? ['*'],
    groups: plugin.manifest.groups ?? ['*'],
    hasDockerfilePartial: fs.existsSync(
      path.join(plugin.dir, 'Dockerfile.partial'),
    ),
    hasMcp: fs.existsSync(path.join(plugin.dir, 'mcp.json')),
    hasContainerSkills: fs.existsSync(
      path.join(plugin.dir, 'container-skills'),
    ),
    envVars: plugin.manifest.containerEnvVars ?? [],
    private:
      plugin.manifest.private === true ||
      path.basename(path.dirname(plugin.dir)) === 'private',
  }));
  if (json) {
    printJson(rows);
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.type.padEnd(7)} ${row.name}${row.private ? ' [private]' : ''} version=${row.version ?? 'unknown'} channels=${row.channels.join(',')} groups=${row.groups.join(',')}\n`,
    );
  }
  if (rows.length === 0) process.stdout.write('(none)\n');
  return 0;
}

function inspectPlugin(
  args: string[],
  projectRoot: string,
  json: boolean,
): number {
  const name = args.find((arg) => !arg.startsWith('-'));
  if (!name) {
    process.stderr.write('plugins inspect: missing plugin name\n');
    return 64;
  }
  const resolved = resolvePlugin(projectRoot, name, false);
  if (!resolved) {
    process.stderr.write(`plugins inspect: plugin not found: ${name}\n`);
    return 1;
  }
  const row = {
    ...resolved,
    channels: resolved.manifest.channels ?? ['*'],
    groups: resolved.manifest.groups ?? ['*'],
    private: resolved.private,
    hasDockerfilePartial: fs.existsSync(
      path.join(resolved.dir, 'Dockerfile.partial'),
    ),
    hasMcp: fs.existsSync(path.join(resolved.dir, 'mcp.json')),
    hasContainerSkills: fs.existsSync(
      path.join(resolved.dir, 'container-skills'),
    ),
    envVars: resolved.manifest.containerEnvVars ?? [],
    hostEnvVars: resolved.manifest.hostEnvVars ?? [],
  };
  if (json) {
    printJson(row);
    return 0;
  }
  process.stdout.write(`name: ${row.name}\n`);
  process.stdout.write(`type: ${row.type}\n`);
  process.stdout.write(`version: ${row.version ?? 'unknown'}\n`);
  process.stdout.write(`private: ${row.private ? 'yes' : 'no'}\n`);
  process.stdout.write(`directory: ${row.dir}\n`);
  process.stdout.write(`channels: ${row.channels.join(',')}\n`);
  process.stdout.write(`groups: ${row.groups.join(',')}\n`);
  process.stdout.write(`container env vars: ${row.envVars.length ? row.envVars.join(', ') : '(none)'}\n`);
  process.stdout.write(`host env vars: ${row.hostEnvVars.length ? row.hostEnvVars.join(', ') : '(none)'}\n`);
  process.stdout.write(`container skills: ${row.hasContainerSkills ? 'yes' : 'no'}\n`);
  process.stdout.write(`mcp: ${row.hasMcp ? 'yes' : 'no'}\n`);
  process.stdout.write(`Dockerfile.partial: ${row.hasDockerfilePartial ? 'yes' : 'no'}\n`);
  return 0;
}

function removePlugin(args: string[], projectRoot: string): number {
  const name = args.find((arg) => !arg.startsWith('-'));
  const channelOnly = hasFlag(args, '--channel');
  if (!name) {
    process.stderr.write(
      channelOnly
        ? 'channels remove: missing channel name\n'
        : 'plugins remove: missing plugin name\n',
    );
    return 64;
  }
  const resolved = resolvePlugin(projectRoot, name, channelOnly);
  if (!resolved) {
    process.stderr.write(
      `${channelOnly ? 'channels' : 'plugins'} remove: plugin not found: ${name}\n`,
    );
    return 1;
  }

  const allOther = allPluginManifests(projectRoot).filter(
    (plugin) => plugin.dir !== resolved.dir,
  );
  const envVars = uniqueStrings(resolved.manifest.containerEnvVars);
  const exclusiveEnvVars = envVars.filter(
    (envVar) =>
      !allOther.some((plugin) =>
        uniqueStrings(plugin.manifest.containerEnvVars).includes(envVar),
      ),
  );
  const sharedEnvVars = envVars.filter(
    (envVar) => !exclusiveEnvVars.includes(envVar),
  );
  const hasDockerfilePartial = fs.existsSync(
    path.join(resolved.dir, 'Dockerfile.partial'),
  );
  const envFiles = envFilesForProject(projectRoot).filter((file) =>
    fs.existsSync(file),
  );

  process.stdout.write(`plugin: ${resolved.name} (${resolved.type})\n`);
  process.stdout.write(`directory: ${resolved.dir}\n`);
  process.stdout.write(
    `exclusive env vars to remove: ${exclusiveEnvVars.length ? exclusiveEnvVars.join(', ') : '(none)'}\n`,
  );
  process.stdout.write(
    `shared env vars to preserve: ${sharedEnvVars.length ? sharedEnvVars.join(', ') : '(none)'}\n`,
  );
  process.stdout.write(
    `env files to scan: ${envFiles.length ? envFiles.join(', ') : '(none)'}\n`,
  );
  process.stdout.write(
    `Dockerfile.partial: ${hasDockerfilePartial ? 'yes - rebuild container image after removal' : 'no'}\n`,
  );
  const mounts = Array.isArray(resolved.manifest.containerMounts)
    ? resolved.manifest.containerMounts
    : [];
  if (mounts.length > 0) {
    process.stdout.write('declared container mounts preserved on disk:\n');
    for (const mount of mounts)
      process.stdout.write(`  ${JSON.stringify(mount)}\n`);
  }

  let channelPlan: {
    messagingGroups: Array<{ id: string; platform_id: string }>;
    taskCount: number;
  } | null = null;
  if (resolved.type === 'channel') {
    initCliDatabase();
    channelPlan = channelRemovalPlan(resolved.name);
    process.stdout.write(
      `channel chats to remove: ${channelPlan.messagingGroups.length}\n`,
    );
    for (const row of channelPlan.messagingGroups)
      process.stdout.write(`  ${row.platform_id}\n`);
    process.stdout.write(
      `scheduled tasks to cancel for channel chats: ${channelPlan.taskCount}\n`,
    );
  }

  if (!hasFlag(args, '--apply')) {
    process.stdout.write(
      'dry-run: pass --apply to remove plugin files and cleanup metadata\n',
    );
    return 0;
  }

  if (resolved.type === 'channel') {
    backupDatabase(projectRoot);
    applyChannelRemoval(resolved.name);
  }
  for (const file of envFiles) {
    removeEnvVarsFromFile(file, exclusiveEnvVars);
  }
  fs.rmSync(resolved.dir, { recursive: true, force: true });
  process.stdout.write(`removed plugin directory: ${resolved.dir}\n`);
  if (hasDockerfilePartial) {
    process.stdout.write(
      'container image should be rebuilt because this plugin had Dockerfile.partial\n',
    );
  }
  process.stdout.write(
    'run `npm run build` and `nanotars restart` to refresh the running service\n',
  );
  return 0;
}

function channelRemovalPlan(channel: string): {
  messagingGroups: Array<{ id: string; platform_id: string }>;
  taskCount: number;
} {
  const db = getDb();
  const messagingGroups = db
    .prepare(
      'SELECT id, platform_id FROM messaging_groups WHERE channel_type = ? ORDER BY platform_id',
    )
    .all(channel) as Array<{ id: string; platform_id: string }>;
  const taskCount = messagingGroups.length
    ? scalarCount(
        `SELECT COUNT(*) FROM scheduled_tasks WHERE chat_jid IN (${messagingGroups.map(() => '?').join(',')})`,
        ...messagingGroups.map((row) => row.platform_id),
      )
    : 0;
  return { messagingGroups, taskCount };
}

function applyChannelRemoval(channel: string): void {
  const plan = channelRemovalPlan(channel);
  const ids = plan.messagingGroups.map((row) => row.id);
  const platformIds = plan.messagingGroups.map((row) => row.platform_id);
  const db = getDb();
  const tx = db.transaction(() => {
    if (platformIds.length > 0) {
      db.prepare(
        `UPDATE scheduled_tasks SET status = 'completed' WHERE chat_jid IN (${platformIds.map(() => '?').join(',')})`,
      ).run(...platformIds);
    }
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      for (const table of [
        'pending_channel_approvals',
        'pending_sender_approvals',
        'user_dms',
      ]) {
        if (tableExists(table))
          db.prepare(
            `DELETE FROM ${table} WHERE messaging_group_id IN (${placeholders})`,
          ).run(...ids);
      }
      if (tableExists('pending_approvals')) {
        db.prepare('DELETE FROM pending_approvals WHERE channel_type = ?').run(
          channel,
        );
      }
      db.prepare(
        `DELETE FROM messaging_group_agents WHERE messaging_group_id IN (${placeholders})`,
      ).run(...ids);
      db.prepare(
        `DELETE FROM messaging_groups WHERE id IN (${placeholders})`,
      ).run(...ids);
    }
  });
  tx();
}

function listTasks(args: string[], json: boolean): number {
  const group = readOption(args, '--group');
  const tasks = group ? getTasksForGroup(group) : getAllTasks();
  if (json) {
    printJson(tasks);
    return 0;
  }
  for (const task of tasks) {
    process.stdout.write(
      `${task.id} group=${task.group_folder} status=${task.status} next=${task.next_run ?? '-'} ${task.prompt.slice(0, 70)}\n`,
    );
  }
  if (tasks.length === 0) process.stdout.write('(none)\n');
  return 0;
}

function cancelTask(args: string[]): number {
  const id = args[0];
  if (!id) {
    process.stderr.write('tasks cancel: missing task id\n');
    return 64;
  }
  const task = getTaskById(id);
  if (!task) {
    process.stderr.write(`tasks cancel: task not found: ${id}\n`);
    return 1;
  }
  if (!hasFlag(args, '--apply')) {
    process.stdout.write(
      `dry-run: would cancel task ${id} (${task.prompt.slice(0, 70)})\n`,
    );
    process.stdout.write('pass --apply to update status\n');
    return 0;
  }
  getDb()
    .prepare(`UPDATE scheduled_tasks SET status = 'cancelled' WHERE id = ?`)
    .run(id);
  process.stdout.write(`cancelled task: ${id}\n`);
  return 0;
}

function listUsers(args: string[], json: boolean): number {
  const groupFolder = readOption(args, '--group');
  const rows = getDb()
    .prepare(
      `
      SELECT u.id, u.kind, u.display_name, u.created_at,
             group_concat(DISTINCT ur.role || ':' || COALESCE(ur.agent_group_id, 'global')) AS roles,
             group_concat(DISTINCT m.agent_group_id) AS member_groups
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN agent_group_members m ON m.user_id = u.id
      GROUP BY u.id
      ORDER BY u.kind, u.id
      `,
    )
    .all() as Array<Record<string, unknown>>;
  const groups = getAllAgentGroups();
  const filtered = groupFolder
    ? rows.filter((row) => {
        const group = groups.find((g) => g.folder === groupFolder);
        if (!group) return false;
        return (
          String(row.roles ?? '').includes(group.id) ||
          String(row.member_groups ?? '').includes(group.id)
        );
      })
    : rows;
  if (json) {
    printJson(filtered);
    return 0;
  }
  for (const row of filtered) {
    process.stdout.write(
      `${row.id} kind=${row.kind} name=${row.display_name ?? ''} roles=${row.roles ?? '-'} member_groups=${row.member_groups ?? '-'}\n`,
    );
  }
  if (filtered.length === 0) process.stdout.write('(none)\n');
  return 0;
}

function grantOrRevokeUser(action: 'grant' | 'revoke', args: string[]): number {
  const [userId, role] = args;
  if (!userId || (role !== 'owner' && role !== 'admin')) {
    process.stderr.write(
      `users ${action}: usage: nanotars users ${action} <user_id> <owner|admin> [--group <folder>] --apply\n`,
    );
    return 64;
  }
  const groupFolder = readOption(args, '--group');
  const group = groupFolder
    ? getAllAgentGroups().find((g) => g.folder === groupFolder)
    : undefined;
  if (groupFolder && !group) {
    process.stderr.write(`users ${action}: group not found: ${groupFolder}\n`);
    return 1;
  }
  if (!hasFlag(args, '--apply')) {
    process.stdout.write(
      `dry-run: would ${action} ${role} for ${userId}${group ? ` scoped to ${group.folder}` : ' globally'}\n`,
    );
    process.stdout.write('pass --apply to update roles\n');
    return 0;
  }
  if (action === 'grant') {
    grantRole({ user_id: userId, role, agent_group_id: group?.id ?? null });
  } else {
    revokeRole({ user_id: userId, role, agent_group_id: group?.id ?? null });
  }
  process.stdout.write(
    `${action === 'grant' ? 'granted' : 'revoked'} ${role}: ${userId}\n`,
  );
  return 0;
}

function listAgents(
  args: string[],
  projectRoot: string,
  json: boolean,
): number {
  const groupFilter = readOption(args, '--group');
  const rows: Array<{
    group: string;
    name: string;
    dir: string;
    config: Record<string, unknown>;
  }> = [];
  const groups = groupFilter
    ? [groupFilter]
    : getAllAgentGroups().map((group) => group.folder);
  for (const folder of groups) {
    const agentsDir = path.join(projectRoot, 'groups', folder, 'agents');
    if (!fs.existsSync(agentsDir)) continue;
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(agentsDir, entry.name, 'agent.json');
      if (!fs.existsSync(configPath)) continue;
      rows.push({
        group: folder,
        name: entry.name,
        dir: path.dirname(configPath),
        config: readJson(configPath),
      });
    }
  }
  if (json) {
    printJson(rows);
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.group}/${row.name}: ${String(row.config.description ?? 'No description')}\n`,
    );
  }
  if (rows.length === 0) process.stdout.write('(none)\n');
  return 0;
}

function listAgentTemplates(projectRoot: string, json: boolean): number {
  const rows = readAgentTemplates(projectRoot);
  if (json) {
    printJson(rows);
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.name}: ${String(row.config.description ?? 'No description')}\n`,
    );
  }
  if (rows.length === 0) process.stdout.write('(none)\n');
  return 0;
}

function addAgent(args: string[], projectRoot: string): number {
  const groupFolder = args[0];
  const name = args[1];
  if (!groupFolder || !name) {
    process.stderr.write(
      'agents add: usage: nanotars agents add <group> <name> [--template <template>|--description <text>] --apply\n',
    );
    return 64;
  }
  const group = getAllAgentGroups().find((g) => g.folder === groupFolder);
  if (!group) {
    process.stderr.write(`agents add: group not found: ${groupFolder}\n`);
    return 1;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
    process.stderr.write(`agents add: invalid agent name: ${name}\n`);
    return 64;
  }
  const targetDir = path.join(
    projectRoot,
    'groups',
    groupFolder,
    'agents',
    name,
  );
  if (fs.existsSync(targetDir) && !hasFlag(args, '--replace')) {
    process.stderr.write(
      `agents add: agent already exists: ${groupFolder}/${name} (pass --replace to overwrite)\n`,
    );
    return 1;
  }

  const templateName = readOption(args, '--template');
  const description = readOption(args, '--description');
  const model = readOption(args, '--model') ?? 'haiku';
  const maxTurns = Number(readOption(args, '--max-turns') ?? '30');
  const identity = readOption(args, '--identity') ?? description;
  const instructions = readOption(args, '--instructions') ?? description;

  process.stdout.write(`agent: ${groupFolder}/${name}\n`);
  process.stdout.write(`target: ${targetDir}\n`);
  if (templateName) {
    const template = readAgentTemplates(projectRoot).find(
      (row) => row.name === templateName,
    );
    if (!template) {
      process.stderr.write(`agents add: template not found: ${templateName}\n`);
      return 1;
    }
    process.stdout.write(`template: ${templateName}\n`);
    process.stdout.write(
      `description: ${String(template.config.description ?? 'No description')}\n`,
    );
    if (!hasFlag(args, '--apply')) {
      process.stdout.write('dry-run: pass --apply to copy template files\n');
      return 0;
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
    copyDir(template.dir, targetDir);
    process.stdout.write(
      `created agent from template: ${groupFolder}/${name}\n`,
    );
    return 0;
  }

  if (!description) {
    process.stderr.write(
      'agents add: custom agents require --description or --template\n',
    );
    return 64;
  }
  const config = {
    description,
    model,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : 30,
  };
  process.stdout.write(`description: ${description}\n`);
  process.stdout.write(`model: ${model}\n`);
  if (!hasFlag(args, '--apply')) {
    process.stdout.write('dry-run: pass --apply to write agent files\n');
    return 0;
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  writeFileAtomic(
    path.join(targetDir, 'agent.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  writeFileAtomic(
    path.join(targetDir, 'IDENTITY.md'),
    `${identity ?? description}\n`,
  );
  writeFileAtomic(
    path.join(targetDir, 'CLAUDE.md'),
    [
      '# Your Role',
      '',
      instructions ?? description,
      '',
      '# Communication Rules',
      '',
      `When reporting back through the lead agent, identify yourself as ${name}.`,
      '',
    ].join('\n'),
  );
  process.stdout.write(`created custom agent: ${groupFolder}/${name}\n`);
  return 0;
}

function removeAgent(args: string[], projectRoot: string): number {
  const groupFolder = args[0];
  const name = args[1];
  if (!groupFolder || !name) {
    process.stderr.write(
      'agents remove: usage: nanotars agents remove <group> <name> --apply\n',
    );
    return 64;
  }
  const targetDir = path.join(
    projectRoot,
    'groups',
    groupFolder,
    'agents',
    name,
  );
  if (!fs.existsSync(path.join(targetDir, 'agent.json'))) {
    process.stderr.write(
      `agents remove: agent not found: ${groupFolder}/${name}\n`,
    );
    return 1;
  }
  process.stdout.write(`agent: ${groupFolder}/${name}\n`);
  process.stdout.write(`directory: ${targetDir}\n`);
  if (!hasFlag(args, '--apply')) {
    process.stdout.write(
      'dry-run: pass --apply to remove this agent directory\n',
    );
    return 0;
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  process.stdout.write(`removed agent: ${groupFolder}/${name}\n`);
  return 0;
}

function prepareClonedChannelManifest(
  sourceManifest: Record<string, any>,
  opts: {
    instanceName: string;
    tokenEnv: string;
    poolEnv: string;
    jidPrefix?: string;
  },
): Record<string, any> {
  const manifest = { ...sourceManifest };
  const sourceTokenEnv =
    typeof sourceManifest.telegramBotTokenEnv === 'string'
      ? sourceManifest.telegramBotTokenEnv
      : undefined;
  const sourcePoolEnv =
    typeof sourceManifest.telegramBotPoolEnv === 'string'
      ? sourceManifest.telegramBotPoolEnv
      : undefined;

  manifest.name = opts.instanceName;

  const envVars = uniqueStrings(sourceManifest.containerEnvVars);
  if (sourceTokenEnv && envVars.includes(sourceTokenEnv)) {
    manifest.containerEnvVars = envVars.map((envVar) =>
      envVar === sourceTokenEnv ? opts.tokenEnv : envVar,
    );
  } else if (envVars.length === 1 && /TOKEN$/i.test(envVars[0])) {
    manifest.containerEnvVars = [opts.tokenEnv];
  } else if (envVars.length > 0) {
    manifest.containerEnvVars = envVars;
  }

  if (sourceTokenEnv) manifest.telegramBotTokenEnv = opts.tokenEnv;
  if (sourcePoolEnv) manifest.telegramBotPoolEnv = opts.poolEnv;
  if (opts.jidPrefix) manifest.telegramJidPrefix = opts.jidPrefix;

  return manifest;
}

function readPluginManifests(
  dir: string,
  channelOnly: boolean,
): Array<{
  name: string;
  type: 'channel' | 'plugin';
  dir: string;
  version: string | null;
  manifest: Record<string, any>;
  private: boolean;
}> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{
    name: string;
    type: 'channel' | 'plugin';
    dir: string;
    version: string | null;
    manifest: Record<string, any>;
    private: boolean;
  }> = [];

  const candidateDirs: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (channelOnly) {
      candidateDirs.push(path.join(dir, entry.name));
      continue;
    }
    if (entry.name === 'channels') continue;
    const entryPath = path.join(dir, entry.name);
    if (fs.existsSync(path.join(entryPath, 'plugin.json'))) {
      candidateDirs.push(entryPath);
      continue;
    }
    for (const sub of fs.readdirSync(entryPath, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      candidateDirs.push(path.join(entryPath, sub.name));
    }
  }

  for (const pluginDir of candidateDirs) {
    const manifestPath = path.join(pluginDir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, 'utf8'),
      ) as Record<string, any>;
      const isChannel =
        manifest.channelPlugin === true || manifest.type === 'channel';
      if (channelOnly && !isChannel) continue;
      out.push({
        name:
          typeof manifest.name === 'string'
            ? manifest.name
            : path.basename(pluginDir),
        type: isChannel ? 'channel' : 'plugin',
        dir: pluginDir,
        version: typeof manifest.version === 'string' ? manifest.version : null,
        manifest,
        private:
          manifest.private === true ||
          path.basename(path.dirname(pluginDir)) === 'private',
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function allPluginManifests(projectRoot: string): Array<{
  name: string;
  type: 'channel' | 'plugin';
  dir: string;
  version: string | null;
  manifest: Record<string, any>;
  private: boolean;
}> {
  return [
    ...readPluginManifests(path.join(projectRoot, 'plugins'), false).filter(
      (plugin) => !plugin.dir.includes(`${path.sep}channels${path.sep}`),
    ),
    ...readPluginManifests(path.join(projectRoot, 'plugins', 'channels'), true),
  ];
}

function resolvePlugin(
  projectRoot: string,
  name: string,
  channelOnly: boolean,
): ReturnType<typeof allPluginManifests>[number] | undefined {
  return allPluginManifests(projectRoot).find(
    (plugin) =>
      plugin.name === name && (!channelOnly || plugin.type === 'channel'),
  );
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((item): item is string => typeof item === 'string'),
        ),
      ].sort()
    : [];
}

function envFilesForProject(projectRoot: string): string[] {
  const files = [path.join(projectRoot, '.env')];
  const groupsDir = path.join(projectRoot, 'groups');
  if (fs.existsSync(groupsDir)) {
    for (const entry of fs.readdirSync(groupsDir, { withFileTypes: true })) {
      if (entry.isDirectory())
        files.push(path.join(groupsDir, entry.name, '.env'));
    }
  }
  return files;
}

function removeEnvVarsFromFile(file: string, envVars: string[]): void {
  if (envVars.length === 0 || !fs.existsSync(file)) return;
  const envSet = new Set(envVars);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const kept = lines.filter((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    return !match || !envSet.has(match[1]);
  });
  writeFileAtomic(file, kept.join('\n'));
}

function backupDatabase(projectRoot: string): void {
  const dbPath = path.join(projectRoot, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return;
  const backupDir = path.join(projectRoot, 'store', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  fs.copyFileSync(dbPath, path.join(backupDir, `messages-cli-${stamp}.db`));
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

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readAgentTemplates(
  projectRoot: string,
): Array<{ name: string; dir: string; config: Record<string, unknown> }> {
  const templatesDir = path.join(
    projectRoot,
    '.claude',
    'skills',
    'nanotars-add-agent',
    'agents',
  );
  if (!fs.existsSync(templatesDir)) return [];
  return fs
    .readdirSync(templatesDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(templatesDir, entry.name, 'agent.json')),
    )
    .map((entry) => {
      const dir = path.join(templatesDir, entry.name);
      return {
        name: entry.name,
        dir,
        config: readJson(path.join(dir, 'agent.json')),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function copyDir(
  src: string,
  dest: string,
  opts: { skip?: Set<string> } = {},
): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (opts.skip?.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to, opts);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isSafeName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}

function defaultChannelTokenEnv(channelName: string): string {
  return `${channelName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BOT_TOKEN`;
}

function defaultChannelPoolEnv(channelName: string): string {
  return `${channelName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BOT_POOL`;
}

function channelAuthStatus(
  projectRoot: string,
  channel: string,
): 'authenticated' | 'present' | 'missing' {
  const base = path.join(projectRoot, 'data', 'channels', channel);
  if (fs.existsSync(path.join(base, 'auth', 'creds.json')))
    return 'authenticated';
  if (fs.existsSync(path.join(base, 'auth-status.txt'))) return 'present';
  return 'missing';
}

function readOption(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function dryRunOnly(command: string, message: string): number {
  process.stdout.write(`${command}: ${message}\n`);
  return 1;
}

function groupsHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    [
      'Usage: nanotars groups <command> [--json]',
      '',
      'Commands:',
      '  list',
      '  show <folder>',
      '  create <folder> [--name <name>] [--instructions <text>] --apply',
      '  register-code <folder>',
      '  migrate-code <folder> --from-channel <name> --to-channel <name> [--apply]',
      '  delete <folder> [--apply]',
      '',
    ].join('\n'),
  );
}

function channelsHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    [
      'Usage: nanotars channels <command> [--json]',
      '',
      'Commands:',
      '  list',
      '  clone <source-channel> <new-channel> [--token-env <KEY>] [--pool-env <KEY>] [--jid-prefix <prefix>] [--no-install] [--replace] --apply',
      '  auth <channel>        Alias guidance; prefer nanotars auth <channel>',
      '  remove <channel> [--apply]',
      '',
    ].join('\n'),
  );
}

function pluginsHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write('Usage: nanotars plugins <list|inspect|remove> [--json]\n');
}

function agentsHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    'Usage: nanotars agents <list|templates|add|remove> [--group <folder>] [--json]\n',
  );
}

function tasksHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    'Usage: nanotars tasks <list|cancel> [--group <folder>] [--json]\n',
  );
}

function usersHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    'Usage: nanotars users <list|grant|revoke> [--group <folder>] [--json]\n',
  );
}
