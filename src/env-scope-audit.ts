/**
 * Env-scope drift audit. Run at host startup after plugins are loaded.
 *
 * Looks for secrets in root `.env` that are declared by exactly one plugin
 * scoped to specific groups (i.e. `groups != ["*"]`) and are not also present
 * in any of those groups' `.env` files. Logs a warning so the operator sees
 * "this secret has wider blast radius than it needs" on every restart.
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

export function auditEnvScope(deps: AuditDeps): void {
  const log = deps.log ?? logger;
  const rootEnv = path.join(deps.projectRoot, '.env');
  const rootKeys = parseEnvKeys(rootEnv);
  if (rootKeys.size === 0) return;

  // Build: key → plugins that declare it
  const declarersByKey = new Map<string, LoadedPlugin[]>();
  for (const plugin of deps.plugins) {
    for (const key of plugin.manifest.containerEnvVars ?? []) {
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
    const groups = plugin.manifest.groups ?? ['*'];
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
}
