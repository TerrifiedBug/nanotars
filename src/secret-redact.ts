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

/**
 * Load secret values from .env that should never appear in output.
 * Call once at startup, after plugins are loaded.
 * @param additionalSafeVars - Extra var names to exempt (e.g. from plugin publicEnvVars)
 */
export function loadSecrets(additionalSafeVars?: string[]): void {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    secretValues = [];
    return;
  }

  const safeVars = new Set(NON_SECRET_VARS);
  if (additionalSafeVars) {
    for (const v of additionalSafeVars) safeVars.add(v);
  }

  secretValues = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    if (safeVars.has(key)) continue;

    // Strip optional quotes
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value.length >= MIN_SECRET_LENGTH) {
      secretValues.push(value);
    }
  }

  // Also extract tokens from ~/.claude/.credentials.json (OAuth auth path)
  loadCredentialsTokens();
}

function loadCredentialsTokens(): void {
  const credsFile = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const data = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
    for (const key of ['accessToken', 'refreshToken'] as const) {
      const token = data[key];
      if (typeof token === 'string' && token.length >= MIN_SECRET_LENGTH) {
        secretValues.push(token);
      }
    }
  } catch {
    // No credentials file or invalid JSON — skip
  }
}

/**
 * Replace any known secret values in the given text with [REDACTED].
 * Uses split/join for literal replacement — no regex escaping needed,
 * which matters because API keys can contain +, $, and other special chars.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const secret of secretValues) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
}
