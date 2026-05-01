import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import process from 'process';

export type ServiceManager = 'launchd' | 'systemd-user' | 'nohup';

export interface ServicePaths {
  projectRoot: string;
  home: string;
  nodePath: string;
}

export function serviceCommand(args: string[], projectRoot: string): number {
  const [subcommand] = args;
  switch (subcommand ?? 'install') {
    case 'install':
      return installService(projectRoot);
    case 'probe':
      return probeService(projectRoot);
    case '-h':
    case '--help':
    case 'help':
      serviceHelp();
      return 0;
    default:
      process.stderr.write(`service: unknown command '${subcommand}'\n\n`);
      serviceHelp(process.stderr);
      return 64;
  }
}

export function daemonCommand(projectRoot: string): Promise<number> {
  return new Promise((resolve) => {
    loadDotEnv(path.join(projectRoot, '.env'));
    const child = spawn(process.execPath, [path.join(projectRoot, 'dist', 'index.js')], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const forward = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
    child.once('error', (error) => {
      process.stderr.write(`[error] daemon: ${error.message}\n`);
      finish(127);
    });
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
      finish(code ?? (signal ? 1 : 0));
    });
  });
}

function installService(projectRoot: string): number {
  const manager = detectServiceManager();
  const paths = {
    projectRoot,
    home: process.env.HOME ?? '',
    nodePath: process.execPath,
  };
  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  switch (manager) {
    case 'launchd':
      return installLaunchd(paths);
    case 'systemd-user':
      return installSystemdUser(paths);
    case 'nohup':
      writeNohupWrapper(paths);
      process.stdout.write(`STATUS: success\nSERVICE_TYPE: nohup\nWRAPPER_PATH: ${path.join(projectRoot, 'start-nanotars.sh')}\n`);
      return 0;
  }
}

function installLaunchd(paths: ServicePaths): number {
  if (process.platform !== 'darwin') {
    process.stderr.write('service install: launchd is macOS-only\n');
    return 1;
  }
  const plistPath = path.join(paths.home, 'Library', 'LaunchAgents', 'com.nanotars.plist');
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, renderLaunchdPlist(paths));
  spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
  const loaded = spawnSync('launchctl', ['load', plistPath], { stdio: 'inherit' });
  if (loaded.status !== 0) return loaded.status ?? 1;
  process.stdout.write(`STATUS: success\nSERVICE_TYPE: launchd\nPLIST_PATH: ${plistPath}\n`);
  return 0;
}

function installSystemdUser(paths: ServicePaths): number {
  const unitDir = path.join(paths.home, '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, 'nanotars.service');
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(unitPath, renderSystemdUnit(paths));
  spawnSync('loginctl', ['enable-linger', process.env.USER ?? ''], { stdio: 'ignore' });
  for (const args of [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', 'nanotars'],
    ['--user', 'restart', 'nanotars'],
  ]) {
    const result = spawnSync('systemctl', args, { stdio: 'inherit' });
    if (result.status !== 0) return result.status ?? 1;
  }
  process.stdout.write(`STATUS: success\nSERVICE_TYPE: systemd-user\nUNIT_PATH: ${unitPath}\n`);
  return 0;
}

export function renderLaunchdPlist(paths: ServicePaths): string {
  const cli = path.join(paths.projectRoot, 'dist', 'cli', 'nanotars.js');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanotars</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(paths.nodePath)}</string>
        <string>${xmlEscape(cli)}</string>
        <string>daemon</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(paths.projectRoot)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${xmlEscape(paths.home)}/.local/bin</string>
        <key>HOME</key>
        <string>${xmlEscape(paths.home)}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${xmlEscape(path.join(paths.projectRoot, 'logs', 'nanotars.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(path.join(paths.projectRoot, 'logs', 'nanotars.error.log'))}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(paths: ServicePaths): string {
  const cli = path.join(paths.projectRoot, 'dist', 'cli', 'nanotars.js');
  return `[Unit]
Description=Nanotars Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${paths.nodePath} ${cli} daemon
WorkingDirectory=${paths.projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${paths.home}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${paths.home}/.local/bin
EnvironmentFile=-${paths.projectRoot}/.env
StandardOutput=append:${paths.projectRoot}/logs/nanotars.log
StandardError=append:${paths.projectRoot}/logs/nanotars.error.log

[Install]
WantedBy=default.target
`;
}

export function writeNohupWrapper(paths: ServicePaths): void {
  const wrapper = path.join(paths.projectRoot, 'start-nanotars.sh');
  fs.writeFileSync(wrapper, renderNohupWrapper(paths));
  fs.chmodSync(wrapper, 0o755);
}

export function renderNohupWrapper(paths: ServicePaths): string {
  const pidfile = path.join(paths.projectRoot, 'nanotars.pid');
  const cli = path.join(paths.projectRoot, 'dist', 'cli', 'nanotars.js');
  return `#!/usr/bin/env bash
# start-nanotars.sh — fallback launcher when systemd-user isn't available.
# Generated by: nanotars service install
# Stop with: kill $(cat "${pidfile}")
set -euo pipefail
cd "${paths.projectRoot}"
if [ -f "${pidfile}" ]; then
  OLD=$(cat "${pidfile}" 2>/dev/null || echo "")
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "Stopping existing nanotars (PID $OLD)..."
    kill "$OLD" 2>/dev/null || true
    sleep 2
  fi
fi
echo "Starting nanotars..."
nohup "${paths.nodePath}" "${cli}" daemon \\
  >> "${path.join(paths.projectRoot, 'logs', 'nanotars.log')}" \\
  2>> "${path.join(paths.projectRoot, 'logs', 'nanotars.error.log')}" &
echo $! > "${pidfile}"
echo "nanotars started (PID $!)"
echo "Logs: tail -f ${path.join(paths.projectRoot, 'logs', 'nanotars.log')}"
`;
}

function probeService(projectRoot: string): number {
  let exitCode = 0;
  const probe = (name: string, value: string, ok: boolean) => {
    process.stdout.write(`${`${name}:`.padEnd(22)} ${value}\n`);
    if (!ok) exitCode = 1;
  };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  probe('node', `v${process.versions.node}${nodeMajor >= 20 ? '' : ' (< v20 - too old)'}`, nodeMajor >= 20);
  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
  probe('pnpm', pnpm.status === 0 ? `v${pnpm.stdout.trim()}` : 'missing', pnpm.status === 0);

  const dockerVersion = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  const dockerInfo = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (dockerVersion.status === 0 && dockerInfo.status === 0) {
    probe('docker', dockerVersion.stdout.trim(), true);
  } else if (dockerVersion.status === 0) {
    probe('docker', 'installed but daemon not running', false);
  } else {
    probe('docker', 'missing', false);
  }

  const image = spawnSync('docker', ['image', 'inspect', 'nanoclaw-agent:latest'], { stdio: 'ignore' });
  probe('agent image', image.status === 0 ? 'nanoclaw-agent:latest present' : 'missing (run ./container/build.sh)', image.status === 0);
  const betterSqlite = path.join(projectRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  probe('host deps', fs.existsSync(betterSqlite) ? 'ok (better-sqlite3 native binding present)' : 'missing (run pnpm install --frozen-lockfile)', fs.existsSync(betterSqlite));
  probe('service', serviceStatus(projectRoot), serviceOk(projectRoot));
  const onecli = spawnSync('onecli', ['version'], { encoding: 'utf8' });
  probe('onecli', onecli.status === 0 ? formatOnecliVersion(onecli.stdout) : 'not installed (optional)', true);
  return exitCode;
}

function formatOnecliVersion(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return 'installed';
  try {
    const parsed = JSON.parse(trimmed) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version ? `v${parsed.version}` : 'installed';
  } catch {
    return trimmed.split('\n')[0] ?? 'installed';
  }
}

function serviceStatus(projectRoot: string): string {
  switch (detectServiceManager()) {
    case 'launchd':
      return spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout.includes('com.nanotars')
        ? 'launchd: com.nanotars loaded'
        : 'launchd: com.nanotars not loaded';
    case 'systemd-user':
      return spawnSync('systemctl', ['--user', 'is-active', 'nanotars'], { stdio: 'ignore' }).status === 0
        ? 'systemd-user: nanotars active'
        : 'systemd-user: nanotars not active';
    case 'nohup': {
      const pidfile = path.join(projectRoot, 'nanotars.pid');
      if (!fs.existsSync(pidfile)) return 'nohup: not running';
      const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
      return Number.isFinite(pid) && isRunning(pid) ? `nohup: PID ${pid} running` : 'nohup: not running';
    }
  }
}

function serviceOk(projectRoot: string): boolean {
  return !serviceStatus(projectRoot).includes('not ');
}

function detectServiceManager(): ServiceManager {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    const ok = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }).status === 0;
    if (ok) return 'systemd-user';
  }
  return 'nohup';
}

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function serviceHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write('Usage: nanotars service <install|probe>\n');
}
