import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSecrets, loadedSecretCount, redactSecrets } from './index.js';

describe('secret-redaction', () => {
  let root: string;
  let credsPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-redact-'));
    credsPath = path.join(root, 'creds.json');
    fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
    // Clear any global state from prior tests.
    loadSecrets({ projectRoot: root, credentialsPath: credsPath });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('no-op when no secrets loaded', () => {
    expect(redactSecrets('hello world')).toBe('hello world');
    expect(loadedSecretCount()).toBe(0);
  });

  it('redacts value from project .env', () => {
    fs.writeFileSync(path.join(root, '.env'), 'NOTION_API_KEY=sk-notion-secret-abcdef\n');
    loadSecrets({ projectRoot: root, credentialsPath: credsPath });
    expect(redactSecrets('my key is sk-notion-secret-abcdef ok')).toBe('my key is [REDACTED] ok');
  });

  it('skips non-secret safelist vars', () => {
    fs.writeFileSync(
      path.join(root, '.env'),
      'ASSISTANT_NAME=TARS_the_assistant\nNOTION_API_KEY=sk-notion-secret-abcdef\n',
    );
    loadSecrets({ projectRoot: root, credentialsPath: credsPath });
    expect(redactSecrets('hi TARS_the_assistant, your key is sk-notion-secret-abcdef')).toBe(
      'hi TARS_the_assistant, your key is [REDACTED]',
    );
  });

  it('NEVER_EXEMPT keys are ALWAYS redacted even if in additionalSafeVars', () => {
    fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=sk-ant-very-very-secret\n');
    loadSecrets({
      projectRoot: root,
      credentialsPath: credsPath,
      additionalSafeVars: ['ANTHROPIC_API_KEY'], // hostile caller tries to exempt
    });
    expect(redactSecrets('my key is sk-ant-very-very-secret')).toBe('my key is [REDACTED]');
  });

  it('redacts values from per-group .env files', () => {
    fs.mkdirSync(path.join(root, 'groups', 'g1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'groups', 'g1', '.env'), 'CALDAV_ACCOUNTS=super-secret-caldav-json\n');
    loadSecrets({ projectRoot: root, credentialsPath: credsPath });
    expect(redactSecrets('contains super-secret-caldav-json inside')).toBe('contains [REDACTED] inside');
  });

  it('strips quotes around values', () => {
    fs.writeFileSync(path.join(root, '.env'), 'KEY1="quoted-secret-value"\nKEY2=\'single-quoted-sec\'\n');
    loadSecrets({ projectRoot: root, credentialsPath: credsPath });
    expect(redactSecrets('quoted-secret-value and single-quoted-sec')).toBe('[REDACTED] and [REDACTED]');
  });

  it('ignores values shorter than MIN_SECRET_LENGTH (false-positive guard)', () => {
    fs.writeFileSync(path.join(root, '.env'), 'SHORT=abc\nLONG=abcdefghijkl\n');
    loadSecrets({ projectRoot: root, credentialsPath: credsPath });
    expect(redactSecrets('abc is short, abcdefghijkl is long')).toBe('abc is short, [REDACTED] is long');
  });

  it('escapes regex metacharacters in secret values', () => {
    fs.writeFileSync(path.join(root, '.env'), 'TRICKY=sk-$^.[].*+-very-tricky\n');
    loadSecrets({ projectRoot: root, credentialsPath: credsPath });
    expect(redactSecrets('value: sk-$^.[].*+-very-tricky trailing')).toBe('value: [REDACTED] trailing');
  });

  it('reads OAuth tokens from credentials file', () => {
    fs.writeFileSync(credsPath, JSON.stringify({ accessToken: 'oauth-access-token-long', refreshToken: 'rft-long-x' }));
    loadSecrets({ projectRoot: root, credentialsPath: credsPath });
    expect(redactSecrets('access oauth-access-token-long refresh rft-long-x')).toBe(
      'access [REDACTED] refresh [REDACTED]',
    );
  });

  it('longer secrets redact before shorter prefixes (sort-desc guarantee)', () => {
    fs.writeFileSync(path.join(root, '.env'), 'A=abcdefgh\nB=abcdefghIJKLmnop\n');
    loadSecrets({ projectRoot: root, credentialsPath: credsPath });
    // Both appear in text; the 16-char one must be fully replaced, not split.
    const out = redactSecrets('here: abcdefghIJKLmnop (also abcdefgh on its own)');
    // If we matched the short one first, we'd get "[REDACTED]IJKLmnop" — which is wrong.
    expect(out).toBe('here: [REDACTED] (also [REDACTED] on its own)');
  });

  it('missing files are silently skipped', () => {
    // No .env, no creds, no groups/ — just a fresh temp dir.
    loadSecrets({ projectRoot: root, credentialsPath: credsPath });
    expect(loadedSecretCount()).toBe(0);
    expect(redactSecrets('any text passes through')).toBe('any text passes through');
  });

  it('dedups identical values across global + group env', () => {
    fs.writeFileSync(path.join(root, '.env'), 'KEY=same-secret-value-1234\n');
    fs.mkdirSync(path.join(root, 'groups', 'g1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'groups', 'g1', '.env'), 'KEY=same-secret-value-1234\n');
    loadSecrets({ projectRoot: root, credentialsPath: credsPath });
    expect(loadedSecretCount()).toBe(1);
  });
});
