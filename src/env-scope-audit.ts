/**
 * Env-scope drift audit. Run at host startup after plugins are loaded.
 *
 * Looks for two env-scope drift shapes:
 * 1. Secrets in root `.env` that are declared by exactly one group-scoped
 *    plugin and are not also present in any of those groups' `.env` files.
 * 2. Secrets that are only in a group `.env` but are declared by a global
 *    plugin, which usually means other groups using the plugin will miss it.
 *
 * Pure observation — never mutates files. The only output is a `logger.warn`
 * line per drifted key.
 */
import fs from 'fs';
import path from 'path';

import type { LoadedPlugin } from './plugin-types.js';
import { logger } from './logger.js';

interface AuditDeps {
  projectRoot: string;
  groupsDir: string;
  plugins: LoadedPlugin[];
  log?: typeof logger;
}

function parseEnvKeys(filePath: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(filePath)) return out;
  for (const raw of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.add(line.slice(0, eq));
  }
  return out;
}

function pluginEnvVars(plugin: LoadedPlugin): string[] {
  return [
    ...(plugin.manifest.containerEnvVars ?? []),
    ...(plugin.manifest.hostEnvVars ?? []),
  ];
}

function pluginGroups(plugin: LoadedPlugin): string[] {
  return plugin.manifest.groups ?? ['*'];
}

function listGroupFolders(groupsDir: string): string[] {
  if (!fs.existsSync(groupsDir)) return [];
  return fs
    .readdirSync(groupsDir)
    .filter((entry) => {
      try {
        return fs.statSync(path.join(groupsDir, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export function auditEnvScope(deps: AuditDeps): void {
  const log = deps.log ?? logger;
  const rootEnv = path.join(deps.projectRoot, '.env');
  const rootKeys = parseEnvKeys(rootEnv);

  // Build: key → plugins that declare it
  const declarersByKey = new Map<string, LoadedPlugin[]>();
  for (const plugin of deps.plugins) {
    for (const key of pluginEnvVars(plugin)) {
      const list = declarersByKey.get(key) ?? [];
      list.push(plugin);
      declarersByKey.set(key, list);
    }
  }

  // Cache group .env keys lazily
  const groupKeyCache = new Map<string, Set<string>>();
  const groupKeys = (group: string): Set<string> => {
    let cached = groupKeyCache.get(group);
    if (cached === undefined) {
      cached = parseEnvKeys(path.join(deps.groupsDir, group, '.env'));
      groupKeyCache.set(group, cached);
    }
    return cached;
  };

  for (const key of rootKeys) {
    const declarers = declarersByKey.get(key);
    if (!declarers || declarers.length !== 1) continue;
    const plugin = declarers[0];
    const groups = pluginGroups(plugin);
    if (groups.includes('*')) continue;

    const inAnyGroupEnv = groups.some((g) => groupKeys(g).has(key));
    if (inAnyGroupEnv) continue;

    log.warn(
      {
        key,
        plugin: plugin.manifest.name,
        scopedGroups: groups,
        suggestedFile: `groups/${groups[0]}/.env`,
      },
      'env-scope drift: secret in root .env is declared only by a group-scoped plugin — moving it to the group .env shrinks blast radius (it would otherwise be filtered out of containers anyway, but root .env is broader-trust state)',
    );
  }

  for (const group of listGroupFolders(deps.groupsDir)) {
    for (const key of groupKeys(group)) {
      if (rootKeys.has(key)) continue;
      const declarers = declarersByKey.get(key);
      if (!declarers) continue;
      const globalDeclarers = declarers.filter((plugin) =>
        pluginGroups(plugin).includes('*'),
      );
      if (globalDeclarers.length === 0) continue;

      log.warn(
        {
          key,
          group,
          plugins: globalDeclarers.map((plugin) => plugin.manifest.name),
          suggestedFile: '.env',
        },
        'env-scope drift: secret is only in a group .env but is declared by a global plugin — move it to root .env or scope the plugin to the group so other matching groups do not miss it',
      );
    }
  }
}
