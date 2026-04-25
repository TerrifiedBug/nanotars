/**
 * Secret redaction for outgoing messages and logs.
 * Prevents accidental leakage of API keys via social engineering
 * (e.g. agent tricked into running `env` or `echo $ANTHROPIC_API_KEY`).
 *
 * Reads ALL values from .env and redacts them from outbound text by default.
 * Only vars on a known non-secret safe-list are exempt. This means any new
 * secret added to .env is automatically protected without touching this code.
 *
 * Also reads OAuth tokens from ~/.claude/.credentials.json, which is the
 * other auth path (copied into containers for SDK token refresh).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const REDACTED = '[REDACTED]';
const MIN_SECRET_LENGTH = 8; // Avoid false positives on short values

// Critical secrets that can NEVER be exempted from redaction, even by plugins.
const NEVER_EXEMPT = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'DASHBOARD_SECRET',
  'ONECLI_API_KEY',
]);

// Config vars whose values are NOT secrets and should NOT be redacted.
// Everything else from .env is treated as potentially sensitive.
const NON_SECRET_VARS = new Set([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CLAUDE_MODEL',
  'CONTAINER_IMAGE',
  'CONTAINER_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'IDLE_TIMEOUT',
  'SCHEDULED_TASK_IDLE_TIMEOUT',
  'MAX_CONCURRENT_CONTAINERS',
  'LOG_LEVEL',
  'NODE_ENV',
  'TZ',
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
 * Load secret values from .env that should never appear in output.
 * Call once at startup, after plugins are loaded.
 */
export function loadSecrets(options: LoadSecretsOptions | string[] = {}): void {
  // Back-compat: allow legacy loadSecrets(['VAR1', 'VAR2']) call shape
  const opts: LoadSecretsOptions = Array.isArray(options)
    ? { additionalSafeVars: options }
    : options;

  const projectRoot = opts.projectRoot ?? process.cwd();
  const credentialsPath = opts.credentialsPath ?? path.join(os.homedir(), '.claude', '.credentials.json');

  const safeVars = new Set(NON_SECRET_VARS);
  for (const v of opts.additionalSafeVars ?? []) safeVars.add(v);

  // Remove critical secrets from safe-list — these must never be exempt
  for (const key of NEVER_EXEMPT) {
    safeVars.delete(key);
  }

  secretValues = [];
  secretValues.push(...valuesFromEnvFile(path.join(projectRoot, '.env'), safeVars));

  // Also scan per-group .env files for secrets to redact
  const groupsDir = path.join(projectRoot, 'groups');
  if (fs.existsSync(groupsDir)) {
    for (const entry of fs.readdirSync(groupsDir)) {
      const groupEnv = path.join(groupsDir, entry, '.env');
      if (fs.existsSync(groupEnv)) {
        secretValues.push(...valuesFromEnvFile(groupEnv, safeVars));
      }
    }
  }

  // Also extract tokens from ~/.claude/.credentials.json (OAuth auth path)
  secretValues.push(...tokensFromCredentialsFile(credentialsPath));

  // De-dup + sort by length desc so longer secrets match before shorter prefixes
  // (avoids partial-match artifacts when one value is a prefix of another — real
  // bug: 'token12345' matched before 'token1234567890', leaving '67890' exposed).
  secretValues = [...new Set(secretValues)].sort((a, b) => b.length - a.length);

  // Build composite regex for single-pass redaction
  if (secretValues.length > 0) {
    const escaped = secretValues.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    secretPattern = new RegExp(escaped.join('|'), 'g');
  } else {
    secretPattern = null;
  }
}

/**
 * Replace any known secret values in the given text with [REDACTED].
 * Uses a pre-built composite regex for single-pass replacement — O(N) instead
 * of O(N*M). Special characters in API keys are properly escaped at load time.
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
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
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
