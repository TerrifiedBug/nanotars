import fs from 'fs';
import os from 'os';
import path from 'path';

import { MOUNT_ALLOWLIST_PATH } from '../../config.js';
import { AllowedRoot, MountAllowlist } from '../../types.js';

const DEFAULT_ALLOWLIST: MountAllowlist = {
  allowedRoots: [],
  blockedPatterns: [],
  nonMainReadOnly: true,
};

export async function mountsCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;

  switch (subcommand ?? 'list') {
    case 'list':
    case 'show':
      return listMounts();
    case 'add':
      return addRoot(rest);
    case 'block':
    case 'add-block':
      return addBlockedPattern(rest);
    case 'remove':
    case 'remove-root':
      return removeRoot(rest);
    case 'remove-block':
      return removeBlockedPattern(rest);
    case 'reset':
      return resetMounts();
    case '-h':
    case '--help':
    case 'help':
      mountsHelp();
      return 0;
    default:
      process.stderr.write(`mounts: unknown command '${subcommand}'\n\n`);
      mountsHelp(process.stderr);
      return 64;
  }
}

function listMounts(): number {
  const cfg = readAllowlist();
  process.stdout.write(`path: ${MOUNT_ALLOWLIST_PATH}\n`);
  process.stdout.write(`nonMainReadOnly: ${cfg.nonMainReadOnly}\n`);
  process.stdout.write('allowedRoots:\n');
  cfg.allowedRoots.forEach((root, index) => {
    const desc = root.description ? ` (${root.description})` : '';
    process.stdout.write(
      `  ${index + 1}. ${root.path} rw=${root.allowReadWrite ? 'yes' : 'no'}${desc}\n`,
    );
  });
  if (cfg.allowedRoots.length === 0) process.stdout.write('  (none)\n');

  process.stdout.write('blockedPatterns:\n');
  cfg.blockedPatterns.forEach((pattern, index) => {
    process.stdout.write(`  ${index + 1}. ${pattern}\n`);
  });
  if (cfg.blockedPatterns.length === 0) process.stdout.write('  (none)\n');
  return 0;
}

function addRoot(args: string[]): number {
  const parsed = parseAddRootArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n\n`);
    mountsHelp(process.stderr);
    return 64;
  }

  const normalized = normalizeHostPath(parsed.path);
  const cfg = readAllowlist();
  const existing = cfg.allowedRoots.find((root) => normalizeHostPath(root.path) === normalized);
  const entry: AllowedRoot = {
    path: parsed.path,
    allowReadWrite: parsed.rw,
    ...(parsed.description ? { description: parsed.description } : {}),
  };

  if (existing) {
    Object.assign(existing, entry);
  } else {
    cfg.allowedRoots.push(entry);
  }
  writeAllowlist(cfg);
  process.stdout.write(`${existing ? 'updated' : 'added'} root: ${parsed.path}\n`);
  return 0;
}

function addBlockedPattern(args: string[]): number {
  const pattern = args[0];
  if (!pattern || pattern.startsWith('-')) {
    process.stderr.write('mounts block: missing pattern\n\n');
    mountsHelp(process.stderr);
    return 64;
  }
  const cfg = readAllowlist();
  if (!cfg.blockedPatterns.includes(pattern)) cfg.blockedPatterns.push(pattern);
  writeAllowlist(cfg);
  process.stdout.write(`blocked pattern: ${pattern}\n`);
  return 0;
}

function removeRoot(args: string[]): number {
  const index = parseIndex(args[0], 'mounts remove');
  if (typeof index === 'string') {
    process.stderr.write(`${index}\n`);
    return 64;
  }
  const cfg = readAllowlist();
  if (index < 0 || index >= cfg.allowedRoots.length) {
    process.stderr.write(`mounts remove: index out of range\n`);
    return 64;
  }
  const [removed] = cfg.allowedRoots.splice(index, 1);
  writeAllowlist(cfg);
  process.stdout.write(`removed root: ${removed.path}\n`);
  return 0;
}

function removeBlockedPattern(args: string[]): number {
  const index = parseIndex(args[0], 'mounts remove-block');
  if (typeof index === 'string') {
    process.stderr.write(`${index}\n`);
    return 64;
  }
  const cfg = readAllowlist();
  if (index < 0 || index >= cfg.blockedPatterns.length) {
    process.stderr.write(`mounts remove-block: index out of range\n`);
    return 64;
  }
  const [removed] = cfg.blockedPatterns.splice(index, 1);
  writeAllowlist(cfg);
  process.stdout.write(`removed blocked pattern: ${removed}\n`);
  return 0;
}

function resetMounts(): number {
  writeAllowlist(DEFAULT_ALLOWLIST);
  process.stdout.write('mount allowlist reset\n');
  return 0;
}

function readAllowlist(): MountAllowlist {
  if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) return structuredClone(DEFAULT_ALLOWLIST);
  const parsed = JSON.parse(fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf8')) as Partial<MountAllowlist>;
  if (!Array.isArray(parsed.allowedRoots)) throw new Error('mount allowlist invalid: allowedRoots must be an array');
  if (!Array.isArray(parsed.blockedPatterns)) throw new Error('mount allowlist invalid: blockedPatterns must be an array');
  if (typeof parsed.nonMainReadOnly !== 'boolean') {
    throw new Error('mount allowlist invalid: nonMainReadOnly must be a boolean');
  }
  return {
    allowedRoots: parsed.allowedRoots,
    blockedPatterns: parsed.blockedPatterns,
    nonMainReadOnly: parsed.nonMainReadOnly,
  };
}

function writeAllowlist(cfg: MountAllowlist): void {
  fs.mkdirSync(path.dirname(MOUNT_ALLOWLIST_PATH), { recursive: true });
  const tmp = `${MOUNT_ALLOWLIST_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, MOUNT_ALLOWLIST_PATH);
}

function parseAddRootArgs(args: string[]):
  | { ok: true; path: string; rw: boolean; description?: string }
  | { ok: false; error: string } {
  const hostPath = args[0];
  if (!hostPath || hostPath.startsWith('-')) return { ok: false, error: 'mounts add: missing host path' };
  let rw = false;
  let description: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--rw' || arg === '--read-write') {
      rw = true;
    } else if (arg === '--ro' || arg === '--read-only') {
      rw = false;
    } else if (arg === '--description' || arg === '--desc') {
      const next = args[i + 1];
      if (!next) return { ok: false, error: `${arg} requires a value` };
      description = next;
      i++;
    } else {
      return { ok: false, error: `mounts add: unknown argument '${arg}'` };
    }
  }
  return { ok: true, path: hostPath, rw, description };
}

function parseIndex(value: string | undefined, command: string): number | string {
  if (!value) return `${command}: missing 1-based index`;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 1) return `${command}: index must be a positive integer`;
  return index - 1;
}

function normalizeHostPath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function mountsHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    [
      'Usage: nanotars mounts <command>',
      '',
      'Commands:',
      '  list                                      Show mount allowlist',
      '  add <path> [--rw] [--description <text>]  Add or update an allowed root',
      '  block <pattern>                          Add blocked path component',
      '  remove <index>                           Remove allowed root by list index',
      '  remove-block <index>                     Remove blocked pattern by list index',
      '  reset                                    Reset to no additional mounts',
      '',
    ].join('\n'),
  );
}
