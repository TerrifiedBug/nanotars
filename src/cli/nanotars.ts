#!/usr/bin/env node
/**
 * User-facing `nanotars` CLI.
 *
 * The installed shell wrapper should stay as a tiny launcher. Command parsing
 * and host/admin behavior lives here so new surfaces can share typed helpers,
 * structured output, tests, and eventually DB transactions.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import process from 'process';

import { dbCommand } from './commands/db.js';
import { dashboardCommand } from './commands/dashboard.js';
import { agentsCommand, channelsCommand, groupsCommand, pluginsCommand, tasksCommand, usersCommand } from './commands/inventory.js';
import { doctorCommand, envCommand, logsCommand } from './commands/doctor.js';
import { modelCommand } from './commands/model.js';
import { mountsCommand } from './commands/mounts.js';
import { runtimeCommand } from './commands/runtime.js';
import { daemonCommand, serviceCommand } from './commands/service.js';
import { runPairMain } from './pair-main.js';

const PROJECT_ROOT = process.cwd();
const LABEL_LAUNCHD = 'com.nanotars';
const PLIST_PATH = path.join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `${LABEL_LAUNCHD}.plist`);
const UNIT_NAME = 'nanotars';
const PIDFILE = path.join(PROJECT_ROOT, 'nanotars.pid');

type ServiceManager = 'launchd' | 'systemd-user' | 'nohup';

interface PlatformInfo {
  platform: 'macos' | 'linux' | 'unknown';
  isRoot: boolean;
  serviceManager: ServiceManager;
}

function usage(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    [
      'Usage: nanotars [command]',
      '',
      'Without a command, opens Claude Code in the NanoTars install directory.',
      'Unknown commands are passed through to Claude Code as a one-shot prompt.',
      '',
      'Commands:',
      '  start                  Start the nanotars service',
      '  stop                   Stop the nanotars service',
      '  restart [--no-build]   Build and restart the service',
      '  status                 Show service + dependency status',
      '  logs                   Tail logs/nanotars.log',
      '  pair-main [--channel]  Issue a pairing code for the main control chat',
      '  auth <channel>         Run channel-specific auth.js',
      '  model                  Get, set, or reset the agent model override',
      '  mounts                 Manage container mount allowlist',
      '  db                     Database stats, integrity, and maintenance',
      '  dashboard              Start/status/stop the local monitoring dashboard',
      '  groups                 List/show/register group wiring',
      '  channels               List installed channel plugins',
      '  plugins                List installed plugins',
      '  agents                 List, add, or remove group subagents',
      '  tasks                  List or cancel scheduled tasks',
      '  users                  List or update user roles',
      '  doctor                 Structured health summary',
      '  env audit              Audit declared plugin env vars',
      '  runtime                Runtime/container activity snapshot',
      '  service                Install service files or run health probe',
      '  help                   Show this help',
      '',
    ].join('\n'),
  );
}

function info(message: string): void {
  process.stdout.write(`[info] ${message}\n`);
}

function warn(message: string): void {
  process.stderr.write(`[warn] ${message}\n`);
}

function error(message: string): void {
  process.stderr.write(`[error] ${message}\n`);
}

function commandExists(command: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function run(command: string, args: string[], opts: { cwd?: string; allowFailure?: boolean } = {}): number {
  const result = spawnSync(command, args, {
    cwd: opts.cwd ?? PROJECT_ROOT,
    stdio: 'inherit',
  });
  if (result.error) {
    error(`${command}: ${result.error.message}`);
    if (!opts.allowFailure) process.exit(127);
    return 127;
  }
  const status = result.status ?? (result.signal ? 1 : 0);
  if (status !== 0 && !opts.allowFailure) process.exit(status);
  return status;
}

function execReplacing(command: string, args: string[], cwd = PROJECT_ROOT): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
    child.on('error', (err) => {
      error(`${command}: ${err.message}`);
      resolve(127);
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function detectPlatform(): PlatformInfo {
  const uname = spawnSync('uname', ['-s'], { encoding: 'utf8' }).stdout.trim();
  const platform = uname === 'Darwin' ? 'macos' : uname === 'Linux' ? 'linux' : 'unknown';
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  let serviceManager: ServiceManager = 'nohup';
  if (platform === 'macos') {
    serviceManager = 'launchd';
  } else if (platform === 'linux' && !isRoot && commandExists('systemctl')) {
    const ok = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }).status === 0;
    serviceManager = ok ? 'systemd-user' : 'nohup';
  }

  return { platform, isRoot, serviceManager };
}

function serviceManager(): ServiceManager {
  return detectPlatform().serviceManager;
}

async function startService(): Promise<number> {
  switch (serviceManager()) {
    case 'launchd':
      if (!fs.existsSync(PLIST_PATH)) {
        error(`${PLIST_PATH} not found - run 'nanotars service install' first`);
        return 1;
      }
      if (run('launchctl', ['load', PLIST_PATH], { allowFailure: true }) !== 0) {
        run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/${LABEL_LAUNCHD}`]);
      }
      break;
    case 'systemd-user':
      run('systemctl', ['--user', 'start', UNIT_NAME]);
      break;
    case 'nohup':
      startNohup();
      break;
  }
  info('started');
  return 0;
}

async function stopService(): Promise<number> {
  switch (serviceManager()) {
    case 'launchd':
      run('launchctl', ['unload', PLIST_PATH], { allowFailure: true });
      break;
    case 'systemd-user':
      run('systemctl', ['--user', 'stop', UNIT_NAME]);
      break;
    case 'nohup':
      stopNohup();
      break;
  }
  info('stopped');
  return 0;
}

function stopNohup(): void {
  if (!fs.existsSync(PIDFILE)) return;
  const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
  if (Number.isFinite(pid) && pid > 0 && isRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    for (let i = 0; i < 30; i++) {
      if (!isRunning(pid)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  fs.rmSync(PIDFILE, { force: true });
}

function startNohup(): void {
  fs.mkdirSync(path.join(PROJECT_ROOT, 'logs'), { recursive: true });
  stopNohup();

  const out = fs.openSync(path.join(PROJECT_ROOT, 'logs', 'nanotars.log'), 'a');
  const err = fs.openSync(path.join(PROJECT_ROOT, 'logs', 'nanotars.error.log'), 'a');
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'dist', 'cli', 'nanotars.js'), 'daemon'], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env,
  });
  fs.writeFileSync(PIDFILE, String(child.pid));
  child.unref();
  process.stdout.write(`Starting nanotars...\nnanotars started (PID ${child.pid})\nLogs: tail -f ${path.join(PROJECT_ROOT, 'logs', 'nanotars.log')}\n`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function restartService(args: string[]): Promise<number> {
  const shouldBuild = !args.includes('--no-build');
  if (shouldBuild) {
    if (fs.existsSync(path.join(PROJECT_ROOT, 'package.json')) && fs.existsSync(path.join(PROJECT_ROOT, 'node_modules'))) {
      info('building (tsc - pass --no-build to skip)');
      run('npm', ['run', 'build']);
    } else {
      warn('skipping build - package.json or node_modules missing');
    }
  }

  switch (serviceManager()) {
    case 'launchd':
      run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/${LABEL_LAUNCHD}`]);
      break;
    case 'systemd-user':
      run('systemctl', ['--user', 'restart', UNIT_NAME]);
      break;
    case 'nohup':
      stopNohup();
      await startService();
      break;
  }
  info('restarted');
  return 0;
}

async function statusService(): Promise<number> {
  return serviceCommand(['probe'], PROJECT_ROOT);
}

async function tailLogs(): Promise<number> {
  const log = path.join(PROJECT_ROOT, 'logs', 'nanotars.log');
  const err = path.join(PROJECT_ROOT, 'logs', 'nanotars.error.log');

  if (!fs.existsSync(log) && !fs.existsSync(err)) {
    warn(`${log} not present - service may not have started`);
    return 0;
  }

  if ((!fs.existsSync(log) || fs.statSync(log).size === 0) && fs.existsSync(err) && fs.statSync(err).size > 0) {
    warn(`${log} is empty; service likely crashed at start. Last 30 lines of ${err}:`);
    process.stdout.write('----------------------------------------------------------------\n');
    run('tail', ['-n', '30', err], { allowFailure: true });
    process.stdout.write('----------------------------------------------------------------\n');
    if (fs.existsSync(PIDFILE)) {
      const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
      if (Number.isFinite(pid) && !isRunning(pid)) {
        warn(`PID ${pid} in ${PIDFILE} is no longer running. Run: nanotars start`);
      }
    }
    return 0;
  }

  return execReplacing('tail', ['-f', log]);
}

async function auth(args: string[]): Promise<number> {
  const channel = args[0];
  if (!channel) {
    error('usage: nanotars auth <channel> [args...]');
    const channelsDir = path.join(PROJECT_ROOT, 'plugins', 'channels');
    if (fs.existsSync(channelsDir)) {
      const available = fs
        .readdirSync(channelsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .join(' ');
      info(available ? `installed channels: ${available}` : 'no channel plugins installed yet');
    } else {
      info('no channel plugins installed yet');
    }
    return 1;
  }

  const script = path.join(PROJECT_ROOT, 'plugins', 'channels', channel, 'auth.js');
  if (!fs.existsSync(script)) {
    error(`no auth.js found for channel '${channel}' (expected ${script})`);
    info(`is the channel plugin installed? Try /add-channel-${channel}`);
    return 1;
  }
  return execReplacing('node', [script, ...args.slice(1)]);
}

async function pairMain(args: string[]): Promise<number> {
  try {
    const opts = parsePairMainArgs(args);
    if (opts.help) {
      pairMainHelp();
      return 0;
    }
    const result = await runPairMain({ channel: opts.channel });
    if (result.seededAgentGroup) {
      process.stdout.write(`Seeded agent_groups[folder='main'].\n`);
    }
    process.stdout.write(
      [
        '',
        `  Pairing code: ${result.code}`,
        '',
        `  Send these 4 digits as a message in the ${result.channel} chat you want to`,
        '  register as your main control chat. The bot will confirm the pair once it',
        '  sees the code.',
        '',
        `  Code expires: ${result.expires_at ?? 'never'}`,
        '',
      ].join('\n'),
    );
    return 0;
  } catch (err) {
    error(`pair-main: ${(err as Error).message}`);
    return 1;
  }
}

function parsePairMainArgs(argv: string[]): { channel?: string; help: boolean } {
  const parsed: { channel?: string; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '--channel') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) throw new Error('--channel requires a value');
      parsed.channel = next;
      i++;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function pairMainHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    [
      'Usage: nanotars pair-main [--channel <name>]',
      '',
      'Allocate a 4-digit pairing code that registers a chat as the main control chat.',
      'Send the code as a message from the chat you want to register.',
      '',
      'Options:',
      '  --channel <name>   Channel plugin to scope the code to.',
      '  -h, --help         Show this help.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  switch (command ?? '') {
    case '':
      return execReplacing('claude', []);
    case 'start':
      return startService();
    case 'stop':
      return stopService();
    case 'restart':
      return restartService(args);
    case 'status':
      return statusService();
    case 'logs':
      if (args[0] === 'errors') return logsCommand(args, PROJECT_ROOT);
      return tailLogs();
    case 'pair-main':
      return pairMain(args);
    case 'auth':
      return auth(args);
    case 'model':
      return modelCommand(args, PROJECT_ROOT);
    case 'mounts':
    case 'mount':
      return mountsCommand(args);
    case 'db':
    case 'database':
      return dbCommand(args, PROJECT_ROOT);
    case 'dashboard':
      return dashboardCommand(args, PROJECT_ROOT);
    case 'groups':
      return groupsCommand(args);
    case 'channels':
      if (args[0] === 'auth') return auth(args.slice(1));
      return channelsCommand(args, PROJECT_ROOT);
    case 'plugins':
    case 'plugin':
      return pluginsCommand(args, PROJECT_ROOT);
    case 'agents':
    case 'agent':
      return agentsCommand(args, PROJECT_ROOT);
    case 'migrate-channel':
      return groupsCommand(['migrate-code', ...args]);
    case 'tasks':
      return tasksCommand(args);
    case 'users':
      return usersCommand(args);
    case 'doctor':
      return doctorCommand(args, PROJECT_ROOT);
    case 'env':
      return envCommand(args, PROJECT_ROOT);
    case 'runtime':
      return runtimeCommand(args);
    case 'service':
      return serviceCommand(args, PROJECT_ROOT);
    case 'daemon':
      return daemonCommand(PROJECT_ROOT);
    case '-h':
    case '--help':
    case 'help':
      usage();
      return 0;
    default:
      return execReplacing('claude', [command, ...args]);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    error((err as Error).stack ?? String(err));
    process.exitCode = 2;
  });
