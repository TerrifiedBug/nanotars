import fs from 'fs';
import path from 'path';
import process from 'process';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';

import { collectDashboardSnapshot } from '../../dashboard/snapshot.js';
import { startDashboardServer } from '../../dashboard/server.js';
import { createSchema, getDb, initDatabase } from '../../db/init.js';
import { readEnvFile } from '../../env.js';
import { parseGlobalFlags, printJson } from './common.js';

interface DashboardOptions {
  host: string;
  port: number;
  secret?: string;
}

export async function dashboardCommand(args: string[], projectRoot: string): Promise<number> {
  const { json, rest } = parseGlobalFlags(args);
  const [subcommand, ...subArgs] = rest;
  switch (subcommand ?? 'status') {
    case 'start':
      return startDashboard(projectRoot, parseOptions(subArgs, projectRoot, { generateSecret: true }));
    case 'stop':
      return stopDashboard(projectRoot);
    case 'restart':
      stopDashboard(projectRoot, true);
      return startDashboard(projectRoot, parseOptions(subArgs, projectRoot, { generateSecret: true }));
    case 'status':
      return statusDashboard(projectRoot, json);
    case 'snapshot':
      initDashboardDatabase();
      if (json) printJson(collectDashboardSnapshot(projectRoot));
      else process.stdout.write(`${JSON.stringify(collectDashboardSnapshot(projectRoot), null, 2)}\n`);
      return 0;
    case 'serve':
      return serveDashboard(projectRoot, parseOptions(subArgs, projectRoot));
    case '-h':
    case '--help':
    case 'help':
      dashboardHelp();
      return 0;
    default:
      process.stderr.write(`dashboard: unknown command '${subcommand}'\n\n`);
      dashboardHelp(process.stderr);
      return 64;
  }
}

function startDashboard(projectRoot: string, options: DashboardOptions): number {
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });
  const pidFile = dashboardPidFile(projectRoot);
  const existing = readPid(pidFile);
  if (existing && isRunning(existing)) {
    process.stdout.write(`dashboard already running (PID ${existing})\n`);
    return 0;
  }

  const out = fs.openSync(path.join(projectRoot, 'logs', 'dashboard.log'), 'a');
  const err = fs.openSync(path.join(projectRoot, 'logs', 'dashboard.error.log'), 'a');
  const child = spawn(process.execPath, [
    path.join(projectRoot, 'dist', 'cli', 'nanotars.js'),
    'dashboard',
    'serve',
    '--host',
    options.host,
    '--port',
    String(options.port),
  ], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      ...(options.secret ? { DASHBOARD_SECRET: options.secret } : {}),
      DASHBOARD_HOST: options.host,
      DASHBOARD_PORT: String(options.port),
    },
  });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  process.stdout.write(`dashboard started (PID ${child.pid})\n`);
  process.stdout.write(`url: http://${options.host}:${options.port}/dashboard\n`);
  process.stdout.write(`auth: ${options.secret ? 'enabled' : 'disabled (localhost only recommended)'}\n`);
  if (options.secret) process.stdout.write(`token file: ${secretFile(projectRoot)}\n`);
  return 0;
}

function stopDashboard(projectRoot: string, quiet = false): number {
  const pidFile = dashboardPidFile(projectRoot);
  const pid = readPid(pidFile);
  if (!pid) {
    if (!quiet) process.stdout.write('dashboard not running\n');
    return 0;
  }
  if (isRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    for (let i = 0; i < 15; i++) {
      if (!isRunning(pid)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  fs.rmSync(pidFile, { force: true });
  if (!quiet) process.stdout.write('dashboard stopped\n');
  return 0;
}

function statusDashboard(projectRoot: string, json: boolean): number {
  const pid = readPid(dashboardPidFile(projectRoot));
  const running = Boolean(pid && isRunning(pid));
  const options = parseOptions([], projectRoot, { requirePublicSecret: false });
  const status = {
    running,
    pid: running ? pid : null,
    url: `http://${options.host}:${options.port}/dashboard`,
    auth_enabled: Boolean(options.secret),
  };
  if (json) {
    printJson(status);
    return running ? 0 : 1;
  }
  process.stdout.write(running ? `dashboard: running PID ${pid}\n` : 'dashboard: not running\n');
  process.stdout.write(`url: ${status.url}\n`);
  process.stdout.write(`auth: ${status.auth_enabled ? 'enabled' : 'disabled'}\n`);
  return running ? 0 : 1;
}

async function serveDashboard(projectRoot: string, options: DashboardOptions): Promise<number> {
  initDashboardDatabase();
  const server = await startDashboardServer({ projectRoot, ...options });
  process.stdout.write(`dashboard listening on http://${options.host}:${options.port}/dashboard\n`);
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
  return 0;
}

function parseOptions(
  args: string[],
  projectRoot: string,
  flags: { generateSecret?: boolean; requirePublicSecret?: boolean } = {},
): DashboardOptions {
  const env = readEnvFile(['DASHBOARD_HOST', 'DASHBOARD_PORT', 'DASHBOARD_SECRET']);
  const host = readOption(args, '--host') ?? process.env.DASHBOARD_HOST ?? env.DASHBOARD_HOST ?? '0.0.0.0';
  const portRaw = readOption(args, '--port') ?? process.env.DASHBOARD_PORT ?? env.DASHBOARD_PORT ?? '3100';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid dashboard port: ${portRaw}`);
  }
  let secret = readOption(args, '--secret') ?? process.env.DASHBOARD_SECRET ?? env.DASHBOARD_SECRET ?? readSecretFile(projectRoot);
  if (!secret && flags.generateSecret) secret = createSecretFile(projectRoot);
  if ((flags.requirePublicSecret ?? true) && host !== '127.0.0.1' && host !== 'localhost' && !secret) {
    throw new Error(`dashboard secret is required when binding outside localhost; run 'nanotars dashboard start' to generate ${secretFile(projectRoot)}`);
  }
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  return { host, port, secret };
}

function initDashboardDatabase(): void {
  initDatabase();
  createSchema(getDb());
}

function dashboardPidFile(projectRoot: string): string {
  return path.join(projectRoot, 'data', 'dashboard.pid');
}

function secretFile(projectRoot: string): string {
  return path.join(projectRoot, 'data', 'dashboard.secret');
}

function readSecretFile(projectRoot: string): string | undefined {
  const file = secretFile(projectRoot);
  if (!fs.existsSync(file)) return undefined;
  const value = fs.readFileSync(file, 'utf8').trim();
  return value || undefined;
}

function createSecretFile(projectRoot: string): string {
  const file = secretFile(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const secret = `nt-${cryptoRandomHex(32)}`;
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

function cryptoRandomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function readPid(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  const pid = Number(fs.readFileSync(file, 'utf8').trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOption(args: string[], name: string): string | undefined {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function dashboardHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    [
      'Usage: nanotars dashboard <start|stop|restart|status|snapshot> [options]',
      '',
      'Commands:',
      '  start      Start the dashboard daemon',
      '  stop       Stop the dashboard daemon',
      '  restart    Restart the dashboard daemon',
      '  status     Show dashboard daemon status',
      '  snapshot   Print the current dashboard snapshot',
      '',
      'Options:',
      '  --host <host>      Bind host (default: DASHBOARD_HOST or 0.0.0.0)',
      '  --port <port>      Bind port (default: DASHBOARD_PORT or 3100)',
      '  --secret <secret>  Bearer token (default: DASHBOARD_SECRET or data/dashboard.secret)',
      '  --json             JSON output for status/snapshot',
      '',
    ].join('\n'),
  );
}
