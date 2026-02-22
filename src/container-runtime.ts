/**
 * Container Runtime Abstraction
 *
 * Auto-detects whether Docker or Apple Container is available
 * and provides a unified API for container operations.
 */
import { ChildProcessByStdio, execFile, execFileSync, spawn } from 'child_process';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { Writable } from 'stream';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type Runtime = 'docker' | 'apple-container';

let detectedRuntime: Runtime | null = null;

/** Detect which container runtime is available */
export function detectRuntime(): Runtime {
  if (detectedRuntime) return detectedRuntime;

  // Prefer Docker if available (works on both Linux and macOS)
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 10000 });
    detectedRuntime = 'docker';
    return detectedRuntime;
  } catch { /* Docker not available */ }

  // Fall back to Apple Container (macOS only)
  try {
    execFileSync('container', ['system', 'status'], { stdio: 'pipe', timeout: 10000 });
    detectedRuntime = 'apple-container';
    return detectedRuntime;
  } catch { /* Apple Container not available */ }

  throw new Error(
    'No container runtime found. Install Docker (https://docs.docker.com/get-docker/) ' +
    'or Apple Container (https://github.com/apple/container/releases).',
  );
}

/** Get the CLI command name for the detected runtime */
export function cli(): string {
  return detectRuntime() === 'docker' ? 'docker' : 'container';
}

/** Ensure the container system is running and clean up orphaned containers */
export function ensureRunning(): void {
  const runtime = detectRuntime();

  if (runtime === 'apple-container') {
    try {
      execFileSync('container', ['system', 'status'], { stdio: 'pipe' });
      logger.debug('Apple Container system already running');
    } catch {
      logger.info('Starting Apple Container system...');
      try {
        execFileSync('container', ['system', 'start'], { stdio: 'pipe', timeout: 30000 });
        logger.info('Apple Container system started');
      } catch (err) {
        logger.error({ err }, 'Failed to start Apple Container system');
        throw new Error('Apple Container system is required but failed to start');
      }
    }
  } else {
    // Docker daemon is managed externally (systemd, Docker Desktop, etc.)
    try {
      execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 10000 });
      logger.debug('Docker daemon running');
    } catch (err) {
      logger.error({ err }, 'Docker daemon not running');
      throw new Error(
        'Docker daemon is required but not running. Start it with: sudo systemctl start docker',
      );
    }
  }

  // Clean up orphaned NanoClaw containers from previous runs
  cleanupOrphanedContainers();
}

/** List and stop/remove orphaned NanoClaw containers */
function cleanupOrphanedContainers(): void {
  const runtime = detectRuntime();

  try {
    if (runtime === 'apple-container') {
      const output = execFileSync('container', ['ls', '--format', 'json'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      const containers: { status: string; configuration: { id: string } }[] =
        JSON.parse(output || '[]');
      const orphans = containers
        .filter(
          (c) =>
            c.status === 'running' &&
            c.configuration.id.startsWith('nanoclaw-'),
        )
        .map((c) => c.configuration.id);
      for (const name of orphans) {
        try {
          execFileSync('container', ['stop', name], { stdio: 'pipe' });
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        logger.info(
          { count: orphans.length, names: orphans },
          'Stopped orphaned containers',
        );
      }
    } else {
      // Docker: list by name filter, stop, then remove
      const output = execFileSync(
        'docker', ['ps', '-a', '--format', '{{.Names}}', '--filter', 'name=nanoclaw-'],
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      const names = output
        .trim()
        .split('\n')
        .filter(Boolean);
      if (names.length > 0) {
        // Stop running ones
        try {
          execFileSync('docker', ['stop', ...names], { stdio: 'pipe', timeout: 15000 });
        } catch {
          /* some may already be stopped */
        }
        // Remove all
        try {
          execFileSync('docker', ['rm', ...names], { stdio: 'pipe' });
        } catch {
          /* some may already be removed */
        }
        logger.info(
          { count: names.length, names },
          'Cleaned up orphaned containers',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

/** Spawn a container with the given args. Returns the child process. */
export function run(args: string[]): ChildProcessByStdio<Writable, Readable, Readable> {
  return spawn(cli(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Build extra run args needed for the detected runtime */
export function extraRunArgs(): string[] {
  if (detectRuntime() === 'docker') {
    // Chromium needs: ptrace (crashpad), relaxed seccomp (user namespaces
    // for sandbox), sufficient /dev/shm (default 64MB causes OOM), and --init
    // (reaps zombie processes). The seccomp profile is Playwright's official
    // one — Docker's default blocks clone/unshare/ptrace that Chromium needs.
    const seccomp = path.join(__dirname, '..', 'container', 'chromium-seccomp.json');
    return [
      '--cap-drop=ALL',
      '--cap-add=SYS_PTRACE',
      '--security-opt=no-new-privileges',
      '--security-opt', `seccomp=${seccomp}`,
      '--shm-size=2g',
      '--init',
      '--cpus=2',
      '--memory=4g',
      '--pids-limit=256',
    ];
  }
  return [];
}

/** Stop a container gracefully */
export function stop(
  containerName: string,
  callback: (err: Error | null) => void,
): void {
  execFile(cli(), ['stop', containerName], { timeout: 15000 }, callback);
}

/**
 * Fix permissions on writable mount paths for Docker.
 * Docker bind mounts preserve host ownership; the container's node user
 * (UID 1000) needs write access. No-op for Apple Container.
 */
export function fixMountPermissions(hostPath: string): void {
  if (detectRuntime() !== 'docker') return;
  try {
    execFileSync('chown', ['-R', '1000:1000', hostPath], { stdio: 'pipe' });
  } catch {
    /* Non-fatal — may not have permission */
  }
}
