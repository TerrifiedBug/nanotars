import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { getDb } from '../../db/init.js';
import { initCliDatabase, parseGlobalFlags, printJson } from './common.js';

export async function doctorCommand(args: string[], projectRoot: string): Promise<number> {
  const { json } = parseGlobalFlags(args);
  const checks = {
    node: process.version,
    service: serviceStatus(projectRoot),
    database: databaseStatus(),
    plugins: countPluginManifests(projectRoot),
    logs: logStatus(projectRoot),
  };
  if (json) {
    printJson(checks);
  } else {
    for (const [key, value] of Object.entries(checks)) {
      process.stdout.write(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    }
  }
  return 0;
}

export async function logsCommand(args: string[], projectRoot: string): Promise<number> {
  const [subcommand] = args;
  if ((subcommand ?? 'errors') !== 'errors') {
    process.stderr.write('logs: usage: nanotars logs errors\n');
    return 64;
  }
  const errorLog = path.join(projectRoot, 'logs', 'nanotars.error.log');
  const mainLog = path.join(projectRoot, 'logs', 'nanotars.log');
  const target = fs.existsSync(errorLog) && fs.statSync(errorLog).size > 0 ? errorLog : mainLog;
  if (!fs.existsSync(target)) {
    process.stdout.write('no logs found\n');
    return 0;
  }
  const result = spawnSync('tail', ['-n', '80', target], { encoding: 'utf8' });
  const lines = result.stdout
    .split('\n')
    .filter((line) => /error|warn|"level":(40|50)/i.test(line))
    .slice(-30);
  process.stdout.write(lines.length ? `${lines.join('\n')}\n` : 'no recent errors found\n');
  return 0;
}

export async function envCommand(args: string[], projectRoot: string): Promise<number> {
  const [subcommand] = args;
  if ((subcommand ?? 'audit') !== 'audit') {
    process.stderr.write('env: usage: nanotars env audit\n');
    return 64;
  }
  const manifests = findPluginManifests(projectRoot);
  const declared = new Set<string>();
  for (const manifestPath of manifests) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { containerEnvVars?: string[]; hostEnvVars?: string[] };
      for (const name of manifest.containerEnvVars ?? []) declared.add(name);
      for (const name of manifest.hostEnvVars ?? []) declared.add(name);
    } catch {
      // Ignore malformed manifests here; plugin loader/debug commands surface them.
    }
  }
  const envFiles = [path.join(projectRoot, '.env'), ...globGroupEnvFiles(projectRoot)];
  const present = new Set<string>();
  for (const file of envFiles) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
      if (match) present.add(match[1]);
    }
  }
  const missing = [...declared].filter((name) => !present.has(name)).sort();
  process.stdout.write(`declared env vars: ${declared.size}\n`);
  process.stdout.write(`configured env vars: ${present.size}\n`);
  process.stdout.write(`missing declared vars: ${missing.length ? missing.join(', ') : '(none)'}\n`);
  return 0;
}

function serviceStatus(projectRoot: string): string {
  const pidFile = path.join(projectRoot, 'nanotars.pid');
  if (!fs.existsSync(pidFile)) return 'unknown';
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isFinite(pid)) return 'invalid pidfile';
  try {
    process.kill(pid, 0);
    return `running pid=${pid}`;
  } catch {
    return `stale pid=${pid}`;
  }
}

function databaseStatus(): string {
  try {
    initCliDatabase();
    const result = getDb().prepare('PRAGMA integrity_check').pluck().get() as string;
    return result;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function countPluginManifests(projectRoot: string): { total: number; channels: number } {
  const manifests = findPluginManifests(projectRoot);
  let channels = 0;
  for (const manifestPath of manifests) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      if (manifest.channelPlugin === true || manifest.type === 'channel') channels++;
    } catch {
      // ignore
    }
  }
  return { total: manifests.length, channels };
}

function logStatus(projectRoot: string): { main: boolean; error: boolean } {
  return {
    main: fs.existsSync(path.join(projectRoot, 'logs', 'nanotars.log')),
    error: fs.existsSync(path.join(projectRoot, 'logs', 'nanotars.error.log')),
  };
}

function findPluginManifests(projectRoot: string): string[] {
  const roots = [path.join(projectRoot, 'plugins'), path.join(projectRoot, 'plugins', 'channels')];
  const out: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(root, entry.name);
      const manifest = path.join(entryPath, 'plugin.json');
      if (fs.existsSync(manifest)) {
        out.push(manifest);
        continue;
      }
      if (root.endsWith(`${path.sep}channels`)) continue;
      for (const sub of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const nestedManifest = path.join(entryPath, sub.name, 'plugin.json');
        if (fs.existsSync(nestedManifest)) out.push(nestedManifest);
      }
    }
  }
  return [...new Set(out)];
}

function globGroupEnvFiles(projectRoot: string): string[] {
  const groupsDir = path.join(projectRoot, 'groups');
  if (!fs.existsSync(groupsDir)) return [];
  return fs
    .readdirSync(groupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(groupsDir, entry.name, '.env'))
    .filter((file) => fs.existsSync(file));
}
