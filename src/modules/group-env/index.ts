/**
 * Per-group environment variable passthrough.
 *
 * Merges the host's global `.env` with an optional per-group `.env`
 * (`groups/<folder>/.env`), filters to an allowlist declared in the group's
 * `container.json`, shell-quotes each value, and writes the result to
 * `data/env/<agentGroupId>/env`. That directory is bind-mounted RO into the
 * container at `/workspace/env-dir`, and the spawn command sources the
 * `env` file via `set -a; . /workspace/env-dir/env; set +a` before execing
 * the agent-runner.
 *
 * Key design points:
 *   - **Opt-in per key**: if `envAllowlist` is missing or empty, nothing is
 *     passed through. Mirrors OneCLI's `selective` posture — the agent sees
 *     only what the group explicitly asks for.
 *   - **Group wins over global**: a key set in both places takes the group
 *     value, enabling per-group overrides (e.g. different NOTION_API_KEY per
 *     agent group).
 *   - **Shell-quoted**: values are wrapped in single quotes with internal
 *     `'` escaped. Neutralises `$(…)`, backticks, `#`, and other shell
 *     metacharacters at source time. Values reach the agent unchanged.
 *   - **Ported from**: nanotars `src/container-mounts.ts:301-373` — the
 *     plugin-registry allowlist has been replaced by per-group
 *     `container.json.envAllowlist`.
 */
import fs from 'fs';
import path from 'path';

export interface EnvMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface BuildGroupEnvMountArgs {
  agentGroupId: string;
  groupFolder: string;
  allowlist: string[];
  /** Project root containing the global `.env`. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Where `groups/<folder>/.env` lives. Defaults to `<projectRoot>/groups`. */
  groupsDir?: string;
  /** Where the staging dir is written. Defaults to `<projectRoot>/data`. */
  dataDir?: string;
}

const ENV_CONTAINER_PATH = '/workspace/env-dir';

/**
 * Parse a `.env` file and return key → value. Missing file → `{}`.
 *
 * Rules:
 *   - Split on first `=`; trim key and value.
 *   - Blank lines and `#`-prefixed lines are ignored.
 *   - If the value is surrounded by matching `"..."` or `'...'`, strip them.
 *   - Everything else is literal (including embedded `=`, `$`, backticks).
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }

  const result: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Wrap a value in single quotes, escaping internal single quotes.
 *
 * `'` → `'\''` (close, literal apostrophe, reopen). This is the only byte
 * sequence that ends a single-quoted bash literal, so escaping it is
 * sufficient — nothing else (`$`, backticks, `#`, `\n`) expands inside
 * single quotes.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the per-group env mount, or return null if there's nothing to pass.
 *
 * The caller is responsible for pushing the returned mount into the docker
 * args list. Writes the staged env file as a side-effect.
 */
export function buildGroupEnvMount(args: BuildGroupEnvMountArgs): EnvMount | null {
  const { agentGroupId, groupFolder, allowlist } = args;
  const projectRoot = args.projectRoot ?? process.cwd();
  const groupsDir = args.groupsDir ?? path.join(projectRoot, 'groups');
  const dataDir = args.dataDir ?? path.join(projectRoot, 'data');

  if (allowlist.length === 0) return null;

  const globalEnv = parseEnvFile(path.join(projectRoot, '.env'));
  const groupEnv = parseEnvFile(path.join(groupsDir, groupFolder, '.env'));
  const merged: Record<string, string> = { ...globalEnv, ...groupEnv };

  const allowed = new Set(allowlist);
  const filtered: Array<[string, string]> = Object.entries(merged).filter(([k]) => allowed.has(k));

  if (filtered.length === 0) return null;

  const envDir = path.join(dataDir, 'env', agentGroupId);
  fs.mkdirSync(envDir, { recursive: true });

  const contents = filtered.map(([k, v]) => `${k}=${shellQuote(v)}`).join('\n') + '\n';
  const envFile = path.join(envDir, 'env');
  // 0o644 because the file must be readable by the non-root container user
  // (uid 1000). It sits inside `data/env/<agentGroupId>/` which is under
  // the project's `data/` tree and therefore inherits the same host-side
  // access posture as the session DBs.
  fs.writeFileSync(envFile, contents, { mode: 0o644 });

  return {
    hostPath: envDir,
    containerPath: ENV_CONTAINER_PATH,
    readonly: true,
  };
}
