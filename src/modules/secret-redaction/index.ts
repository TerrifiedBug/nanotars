/**
 * Outbound secret redaction.
 *
 * Defends against agents being tricked into echoing env vars into user-
 * facing messages. Reads every value from the host `.env` and every
 * per-group `groups/<folder>/.env` once at startup, subtracts a
 * non-secret safe-list, and builds a single composite regex used for
 * O(n) scrubbing of outbound message content immediately before
 * adapter delivery.
 *
 * Ported from nanotars v1 `src/secret-redact.ts`. Adaptations for v2:
 *   - Paths are injectable (for tests + future flexibility) but default
 *     to `process.cwd()`-relative so the wiring matches v1.
 *   - Keeps the scan of `~/.claude/.credentials.json` as a defensive
 *     second source (harmless if absent — v2 doesn't populate that
 *     file on the host under normal OneCLI flows).
 *
 * `NEVER_EXEMPT` is the critical-secret safety valve: these cannot be
 * removed from the redaction set by any plugin/config path. If a
 * skill insists on "I want my key visible to the user" it has to be
 * a key outside this set.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const REDACTED = '[REDACTED]';
/** Values shorter than this aren't redacted — too many false positives. */
const MIN_SECRET_LENGTH = 8;

/** Critical secrets that can NEVER be added to safeVars, regardless of caller intent. */
const NEVER_EXEMPT = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'DASHBOARD_SECRET',
  'ONECLI_API_KEY',
]);

/**
 * Config vars whose values aren't secrets. Everything else from `.env`
 * gets redacted. Keep this list lean — false negatives (leaking an
 * actual secret) are much more expensive than false positives
 * (redacting a non-secret config value).
 */
const NON_SECRET_VARS = new Set([
  'ASSISTANT_NAME',
  'CLAUDE_MODEL',
  'LOG_LEVEL',
  'NODE_ENV',
  'TZ',
  'TIMEZONE',
  'DASHBOARD_PORT',
  'ONECLI_URL',
]);

let secretValues: string[] = [];
let secretPattern: RegExp | null = null;

export interface LoadSecretsOptions {
  /** Project root for root `.env` + per-group `.env` lookup. Defaults to process.cwd(). */
  projectRoot?: string;
  /** Extra var names to exempt beyond NON_SECRET_VARS (e.g. from plugin `publicEnvVars`). */
  additionalSafeVars?: string[];
  /** Override credentials file path. Defaults to ~/.claude/.credentials.json. */
  credentialsPath?: string;
}

/**
 * (Re)load the redaction set. Idempotent — call again after any change
 * that adds/removes secrets (e.g. a new per-group `.env` file).
 */
export function loadSecrets(options: LoadSecretsOptions = {}): void {
  const projectRoot = options.projectRoot ?? process.cwd();
  const credentialsPath = options.credentialsPath ?? path.join(os.homedir(), '.claude', '.credentials.json');

  const safeVars = new Set(NON_SECRET_VARS);
  for (const v of options.additionalSafeVars ?? []) safeVars.add(v);
  // NEVER_EXEMPT overrides everything — ensure these are treated as secrets
  // even if a caller tried to add them to the safe list.
  for (const key of NEVER_EXEMPT) safeVars.delete(key);

  secretValues = [];
  secretValues.push(...valuesFromEnvFile(path.join(projectRoot, '.env'), safeVars));

  // Per-group .env files — same allowlist semantics.
  const groupsDir = path.join(projectRoot, 'groups');
  if (fs.existsSync(groupsDir)) {
    for (const entry of fs.readdirSync(groupsDir)) {
      const groupEnv = path.join(groupsDir, entry, '.env');
      if (fs.existsSync(groupEnv)) {
        secretValues.push(...valuesFromEnvFile(groupEnv, safeVars));
      }
    }
  }

  // Defensive: Claude Code's OAuth tokens live here when present.
  secretValues.push(...tokensFromCredentialsFile(credentialsPath));

  // De-dup + sort by length desc so longer secrets match before shorter
  // prefixes (avoids partial-match artifacts when one value is a suffix
  // of another — real case: `token` = first 5 chars of `token_abcdef`).
  secretValues = [...new Set(secretValues)].sort((a, b) => b.length - a.length);

  if (secretValues.length > 0) {
    const escaped = secretValues.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    secretPattern = new RegExp(escaped.join('|'), 'g');
  } else {
    secretPattern = null;
  }
}

/**
 * Replace every known-secret substring in `text` with [REDACTED].
 * No-op if `loadSecrets()` hasn't been called or found no secrets.
 */
export function redactSecrets(text: string): string {
  if (!secretPattern) return text;
  secretPattern.lastIndex = 0;
  return text.replace(secretPattern, REDACTED);
}

/** Number of loaded secret values — for logging / test visibility only. */
export function loadedSecretCount(): number {
  return secretValues.length;
}

function valuesFromEnvFile(filePath: string, safeVars: Set<string>): string[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (safeVars.has(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length >= MIN_SECRET_LENGTH) out.push(value);
  }
  return out;
}

function tokensFromCredentialsFile(filePath: string): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const out: string[] = [];
    for (const key of ['accessToken', 'refreshToken'] as const) {
      const token = data[key];
      if (typeof token === 'string' && token.length >= MIN_SECRET_LENGTH) {
        out.push(token);
      }
    }
    return out;
  } catch {
    return [];
  }
}
