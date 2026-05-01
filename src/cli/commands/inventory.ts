import fs from 'fs';
import path from 'path';

import { getAllAgentGroups, getAllSynthesizedGroupRows } from '../../db/agent-groups.js';
import { getDb } from '../../db/init.js';
import { getAllTasks, getTaskById, getTasksForGroup } from '../../db/tasks.js';
import { createPendingCode } from '../../pending-codes.js';
import { grantRole, revokeRole } from '../../permissions/user-roles.js';
import { ScheduledTask } from '../../types.js';
import { hasFlag, initCliDatabase, parseGlobalFlags, printJson } from './common.js';

export async function groupsCommand(args: string[]): Promise<number> {
  const { json, rest } = parseGlobalFlags(args);
  const [subcommand, ...subArgs] = rest;
  initCliDatabase();

  switch (subcommand ?? 'list') {
    case 'list':
      return listGroups(json);
    case 'show':
      return showGroup(subArgs, json);
    case 'register-code':
      return registerCode(subArgs);
    case 'delete':
      return dryRunOnly('groups delete', 'Group deletion is not implemented yet. Use chat admin /delete-group for now.');
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

export async function channelsCommand(args: string[], projectRoot: string): Promise<number> {
  const { json, rest } = parseGlobalFlags(args);
  const [subcommand, ...subArgs] = rest;

  switch (subcommand ?? 'list') {
    case 'list':
      return listChannels(projectRoot, json);
    case 'auth':
      process.stderr.write('channels auth: use `nanotars auth <channel>`\n');
      return 64;
    case 'remove':
      return dryRunOnly('channels remove', 'Channel removal is not implemented yet. Use plugin removal after a dry-run design.');
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

export async function pluginsCommand(args: string[], projectRoot: string): Promise<number> {
  const { json, rest } = parseGlobalFlags(args);
  const [subcommand] = rest;
  switch (subcommand ?? 'list') {
    case 'list':
      return listPlugins(projectRoot, json);
    case 'remove':
      return dryRunOnly('plugin remove', 'Plugin removal is not implemented yet in TS CLI.');
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
  const wirings = getAllSynthesizedGroupRows().filter((w) => w.agent_group_id === group.id);
  const tasks = getTasksForGroup(folder);
  const agentsDir = path.join(process.cwd(), 'groups', folder, 'agents');
  const agents = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(agentsDir, entry.name, 'agent.json')))
        .map((entry) => entry.name)
    : [];
  const result = { group, wirings, tasks, agents };
  if (json) {
    printJson(result);
    return 0;
  }
  process.stdout.write(`${group.folder} (${group.name}) id=${group.id}\n`);
  process.stdout.write(`wirings: ${wirings.length}\n`);
  for (const w of wirings) process.stdout.write(`  ${w.channel_type} ${w.platform_id}\n`);
  process.stdout.write(`tasks: ${tasks.length}\n`);
  process.stdout.write(`agents: ${agents.length ? agents.join(', ') : '(none)'}\n`);
  return 0;
}

async function registerCode(args: string[]): Promise<number> {
  const folder = args[0];
  if (!folder) {
    process.stderr.write('groups register-code: missing folder\n');
    return 64;
  }
  const group = getAllAgentGroups().find((g) => g.folder === folder);
  if (!group) {
    process.stderr.write(`groups register-code: group not found: ${folder}\n`);
    return 1;
  }
  const result = await createPendingCode({
    channel: 'any',
    intent: { kind: 'agent_group', target: group.id },
  });
  process.stdout.write(`Pairing code: ${result.code}\n`);
  process.stdout.write(`Send these 4 digits from the chat to wire to group '${folder}'.\n`);
  process.stdout.write(`Code expires: ${result.expires_at ?? 'never'}\n`);
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
      .prepare('SELECT COUNT(*) AS count FROM messaging_groups WHERE channel_type = ?')
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

function listPlugins(projectRoot: string, json: boolean): number {
  const skillPlugins = readPluginManifests(path.join(projectRoot, 'plugins'), false)
    .filter((plugin) => !plugin.dir.includes(`${path.sep}channels${path.sep}`));
  const channelPlugins = readPluginManifests(path.join(projectRoot, 'plugins', 'channels'), true);
  const rows = [...skillPlugins, ...channelPlugins].map((plugin) => ({
    ...plugin,
    channels: plugin.manifest.channels ?? ['*'],
    groups: plugin.manifest.groups ?? ['*'],
    hasDockerfilePartial: fs.existsSync(path.join(plugin.dir, 'Dockerfile.partial')),
    hasMcp: fs.existsSync(path.join(plugin.dir, 'mcp.json')),
    hasContainerSkills: fs.existsSync(path.join(plugin.dir, 'container-skills')),
    envVars: plugin.manifest.containerEnvVars ?? [],
  }));
  if (json) {
    printJson(rows);
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.type.padEnd(7)} ${row.name} version=${row.version ?? 'unknown'} channels=${row.channels.join(',')} groups=${row.groups.join(',')}\n`,
    );
  }
  if (rows.length === 0) process.stdout.write('(none)\n');
  return 0;
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
    process.stdout.write(`dry-run: would cancel task ${id} (${task.prompt.slice(0, 70)})\n`);
    process.stdout.write('pass --apply to update status\n');
    return 0;
  }
  getDb().prepare(`UPDATE scheduled_tasks SET status = 'cancelled' WHERE id = ?`).run(id);
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
        return String(row.roles ?? '').includes(group.id) || String(row.member_groups ?? '').includes(group.id);
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
    process.stderr.write(`users ${action}: usage: nanotars users ${action} <user_id> <owner|admin> [--group <folder>] --apply\n`);
    return 64;
  }
  const groupFolder = readOption(args, '--group');
  const group = groupFolder ? getAllAgentGroups().find((g) => g.folder === groupFolder) : undefined;
  if (groupFolder && !group) {
    process.stderr.write(`users ${action}: group not found: ${groupFolder}\n`);
    return 1;
  }
  if (!hasFlag(args, '--apply')) {
    process.stdout.write(`dry-run: would ${action} ${role} for ${userId}${group ? ` scoped to ${group.folder}` : ' globally'}\n`);
    process.stdout.write('pass --apply to update roles\n');
    return 0;
  }
  if (action === 'grant') {
    grantRole({ user_id: userId, role, agent_group_id: group?.id ?? null });
  } else {
    revokeRole({ user_id: userId, role, agent_group_id: group?.id ?? null });
  }
  process.stdout.write(`${action === 'grant' ? 'granted' : 'revoked'} ${role}: ${userId}\n`);
  return 0;
}

function readPluginManifests(dir: string, channelOnly: boolean): Array<{
  name: string;
  type: 'channel' | 'plugin';
  dir: string;
  version: string | null;
  manifest: Record<string, any>;
}> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ name: string; type: 'channel' | 'plugin'; dir: string; version: string | null; manifest: Record<string, any> }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'channels' && !channelOnly) continue;
    const pluginDir = path.join(dir, entry.name);
    const manifestPath = path.join(pluginDir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
      const isChannel = manifest.channelPlugin === true || manifest.type === 'channel';
      if (channelOnly && !isChannel) continue;
      out.push({
        name: typeof manifest.name === 'string' ? manifest.name : entry.name,
        type: isChannel ? 'channel' : 'plugin',
        dir: pluginDir,
        version: typeof manifest.version === 'string' ? manifest.version : null,
        manifest,
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function channelAuthStatus(projectRoot: string, channel: string): 'authenticated' | 'present' | 'missing' {
  const base = path.join(projectRoot, 'data', 'channels', channel);
  if (fs.existsSync(path.join(base, 'auth', 'creds.json'))) return 'authenticated';
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
  stream.write('Usage: nanotars groups <list|show|register-code|delete> [--json]\n');
}

function channelsHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write('Usage: nanotars channels <list|auth|remove> [--json]\n');
}

function pluginsHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write('Usage: nanotars plugins <list|remove> [--json]\n');
}

function tasksHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write('Usage: nanotars tasks <list|cancel> [--group <folder>] [--json]\n');
}

function usersHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write('Usage: nanotars users <list|grant|revoke> [--group <folder>] [--json]\n');
}
