import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let homeSpy: ReturnType<typeof vi.spyOn>;

// Dynamic import after mocks — fresh module state each test
let loadSecrets: typeof import('./secret-redact.js').loadSecrets;
let redactSecrets: typeof import('./secret-redact.js').redactSecrets;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-redact-test-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  vi.resetModules();
  const mod = await import('./secret-redact.js');
  loadSecrets = mod.loadSecrets;
  redactSecrets = mod.redactSecrets;
});

afterEach(() => {
  cwdSpy.mockRestore();
  homeSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEnv(content: string): void {
  fs.writeFileSync(path.join(tmpDir, '.env'), content);
}

describe('loadSecrets + redactSecrets', () => {
  it('redacts ANTHROPIC_API_KEY from output', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant-secret-key-12345678');
    loadSecrets();

    expect(redactSecrets('Here is the key: sk-ant-secret-key-12345678')).toBe(
      'Here is the key: [REDACTED]',
    );
  });

  it('redacts CLAUDE_CODE_OAUTH_TOKEN from output', () => {
    writeEnv('CLAUDE_CODE_OAUTH_TOKEN=oauth-token-abcdef99');
    loadSecrets();

    expect(redactSecrets('token=oauth-token-abcdef99')).toBe('token=[REDACTED]');
  });

  it('redacts multiple secrets in the same string', () => {
    writeEnv(
      'ANTHROPIC_API_KEY=sk-ant-aaaa-bbbb\nCLAUDE_CODE_OAUTH_TOKEN=oauth-bbbb-cccc',
    );
    loadSecrets();

    expect(redactSecrets('key=sk-ant-aaaa-bbbb and token=oauth-bbbb-cccc end')).toBe(
      'key=[REDACTED] and token=[REDACTED] end',
    );
  });

  it('redacts all occurrences of the same secret', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant-repeated-key');
    loadSecrets();

    expect(redactSecrets('first: sk-ant-repeated-key, second: sk-ant-repeated-key')).toBe(
      'first: [REDACTED], second: [REDACTED]',
    );
  });

  it('handles double-quoted values in .env', () => {
    writeEnv('ANTHROPIC_API_KEY="sk-ant-quoted-value"');
    loadSecrets();

    expect(redactSecrets('key is sk-ant-quoted-value here')).toBe(
      'key is [REDACTED] here',
    );
  });

  it('handles single-quoted values in .env', () => {
    writeEnv("ANTHROPIC_API_KEY='sk-ant-single-quoted'");
    loadSecrets();

    expect(redactSecrets('sk-ant-single-quoted')).toBe('[REDACTED]');
  });

  it('ignores values shorter than minimum length', () => {
    writeEnv('ANTHROPIC_API_KEY=short');
    loadSecrets();

    expect(redactSecrets('short')).toBe('short');
  });

  it('returns text unchanged when no .env exists', () => {
    loadSecrets();
    expect(redactSecrets('sk-ant-anything')).toBe('sk-ant-anything');
  });

  it('handles empty lines and whitespace in .env', () => {
    writeEnv('\n  \n\nANTHROPIC_API_KEY=sk-ant-spaced-key\n\n');
    loadSecrets();

    expect(redactSecrets('sk-ant-spaced-key')).toBe('[REDACTED]');
  });

  it('redacts secrets in multiline output (env dump)', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant-multiline-test');
    loadSecrets();

    const envDump = [
      'HOME=/home/node',
      'PATH=/usr/bin:/bin',
      'ANTHROPIC_API_KEY=sk-ant-multiline-test',
      'NODE_VERSION=20.0.0',
    ].join('\n');

    expect(redactSecrets(envDump)).toBe(
      [
        'HOME=/home/node',
        'PATH=/usr/bin:/bin',
        'ANTHROPIC_API_KEY=[REDACTED]',
        'NODE_VERSION=20.0.0',
      ].join('\n'),
    );
  });

  it('handles secrets containing regex-special characters', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant-key+with.special$chars');
    loadSecrets();

    expect(redactSecrets('found sk-ant-key+with.special$chars here')).toBe(
      'found [REDACTED] here',
    );
  });

  it('ignores comments in .env', () => {
    writeEnv('# ANTHROPIC_API_KEY=sk-ant-commented-out\nANTHROPIC_API_KEY=sk-ant-actual-val');
    loadSecrets();

    expect(redactSecrets('sk-ant-commented-out')).toBe('sk-ant-commented-out');
    expect(redactSecrets('sk-ant-actual-val')).toBe('[REDACTED]');
  });
});

describe('redacts all .env values by default (not just named secrets)', () => {
  it('redacts any unknown var not on the safe-list', () => {
    writeEnv('EMAIL_ACCOUNTS=user:pass@imap.gmail.com');
    loadSecrets();

    expect(redactSecrets('user:pass@imap.gmail.com')).toBe('[REDACTED]');
  });

  it('redacts CALDAV_ACCOUNTS with embedded credentials', () => {
    writeEnv('CALDAV_ACCOUNTS=https://user:secret123@caldav.example.com');
    loadSecrets();

    expect(redactSecrets('https://user:secret123@caldav.example.com')).toBe('[REDACTED]');
  });

  it('redacts plugin env vars like GIPHY_API_KEY', () => {
    writeEnv('GIPHY_API_KEY=gp-fake-key-12345');
    loadSecrets();

    expect(redactSecrets('gp-fake-key-12345')).toBe('[REDACTED]');
  });

  it('redacts GH_TOKEN', () => {
    writeEnv('GH_TOKEN=ghp_fakegithubtoken123');
    loadSecrets();

    expect(redactSecrets('ghp_fakegithubtoken123')).toBe('[REDACTED]');
  });

  it('redacts NANOCLAW_WEBHOOK_SECRET', () => {
    writeEnv('NANOCLAW_WEBHOOK_SECRET=whsec-long-enough-value');
    loadSecrets();

    expect(redactSecrets('whsec-long-enough-value')).toBe('[REDACTED]');
  });

  it('redacts vars without KEY/TOKEN/SECRET in name', () => {
    writeEnv('CLAUDE_MEM_URL=http://172.17.0.1:37777');
    loadSecrets();

    // CLAUDE_MEM_URL is not on the safe-list, so its value gets redacted
    expect(redactSecrets('http://172.17.0.1:37777')).toBe('[REDACTED]');
  });
});

describe('plugin publicEnvVars (additionalSafeVars)', () => {
  it('exempts vars passed as additionalSafeVars', () => {
    writeEnv([
      'FRESHRSS_URL=http://freshrss.local:8080',
      'FRESHRSS_API_KEY=fr-secret-api-key-val',
    ].join('\n'));
    loadSecrets(['FRESHRSS_URL']);

    // FRESHRSS_URL is in additionalSafeVars — not redacted
    expect(redactSecrets('http://freshrss.local:8080')).toBe('http://freshrss.local:8080');
    // FRESHRSS_API_KEY is NOT in additionalSafeVars — redacted
    expect(redactSecrets('fr-secret-api-key-val')).toBe('[REDACTED]');
  });

  it('merges additionalSafeVars with built-in safe-list', () => {
    writeEnv([
      'ASSISTANT_NAME=TARS-EXTENDED',
      'CLAUDE_MEM_URL=http://172.17.0.1:37777',
      'ANTHROPIC_API_KEY=sk-ant-secret-here',
    ].join('\n'));
    loadSecrets(['CLAUDE_MEM_URL']);

    // Built-in safe-list
    expect(redactSecrets('TARS-EXTENDED')).toBe('TARS-EXTENDED');
    // Plugin publicEnvVar
    expect(redactSecrets('http://172.17.0.1:37777')).toBe('http://172.17.0.1:37777');
    // Secret
    expect(redactSecrets('sk-ant-secret-here')).toBe('[REDACTED]');
  });
});

describe('non-secret safe-list exemptions', () => {
  it('does NOT redact ASSISTANT_NAME', () => {
    writeEnv('ASSISTANT_NAME=TARS-EXTENDED');
    loadSecrets();

    expect(redactSecrets('TARS-EXTENDED')).toBe('TARS-EXTENDED');
  });

  it('does NOT redact CLAUDE_MODEL', () => {
    writeEnv('CLAUDE_MODEL=claude-sonnet-4-5-20250514');
    loadSecrets();

    expect(redactSecrets('claude-sonnet-4-5-20250514')).toBe('claude-sonnet-4-5-20250514');
  });

  it('does NOT redact CONTAINER_IMAGE', () => {
    writeEnv('CONTAINER_IMAGE=nanoclaw-agent:latest');
    loadSecrets();

    expect(redactSecrets('nanoclaw-agent:latest')).toBe('nanoclaw-agent:latest');
  });

  it('does NOT redact LOG_LEVEL', () => {
    writeEnv('LOG_LEVEL=debug-verbose');
    loadSecrets();

    expect(redactSecrets('debug-verbose')).toBe('debug-verbose');
  });

  it('does NOT redact CONTAINER_TIMEOUT', () => {
    writeEnv('CONTAINER_TIMEOUT=18000000');
    loadSecrets();

    expect(redactSecrets('18000000')).toBe('18000000');
  });

  it('safe-list vars mixed with secret vars', () => {
    writeEnv([
      'ASSISTANT_NAME=TARS-EXTENDED',
      'ANTHROPIC_API_KEY=sk-ant-real-secret-val',
      'CLAUDE_MODEL=claude-sonnet-4-5-20250514',
    ].join('\n'));
    loadSecrets();

    expect(redactSecrets('TARS-EXTENDED')).toBe('TARS-EXTENDED');
    expect(redactSecrets('sk-ant-real-secret-val')).toBe('[REDACTED]');
    expect(redactSecrets('claude-sonnet-4-5-20250514')).toBe('claude-sonnet-4-5-20250514');
  });
});

function writeCreds(data: object): void {
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify(data));
}

describe('credentials.json OAuth token redaction', () => {
  it('redacts accessToken from credentials.json', () => {
    writeEnv('');
    writeCreds({ accessToken: 'oauth-access-token-xyz123' });
    loadSecrets();

    expect(redactSecrets('token is oauth-access-token-xyz123')).toBe('token is [REDACTED]');
  });

  it('redacts refreshToken from credentials.json', () => {
    writeEnv('');
    writeCreds({ refreshToken: 'oauth-refresh-token-abc456' });
    loadSecrets();

    expect(redactSecrets('oauth-refresh-token-abc456')).toBe('[REDACTED]');
  });

  it('redacts both accessToken and refreshToken', () => {
    writeEnv('');
    writeCreds({
      accessToken: 'access-token-abcdef',
      refreshToken: 'refresh-token-ghijkl',
    });
    loadSecrets();

    expect(redactSecrets('access-token-abcdef and refresh-token-ghijkl')).toBe(
      '[REDACTED] and [REDACTED]',
    );
  });

  it('combines .env secrets with credentials.json tokens', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant-env-secret-val');
    writeCreds({ accessToken: 'oauth-creds-file-token' });
    loadSecrets();

    expect(redactSecrets('sk-ant-env-secret-val')).toBe('[REDACTED]');
    expect(redactSecrets('oauth-creds-file-token')).toBe('[REDACTED]');
  });

  it('works when credentials.json does not exist', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant-no-creds-file');
    loadSecrets();

    expect(redactSecrets('sk-ant-no-creds-file')).toBe('[REDACTED]');
  });
});

describe('NEVER_EXEMPT: critical secrets cannot be exempted', () => {
  it('redacts ANTHROPIC_API_KEY even when passed as additionalSafeVars', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant-never-exempt-key');
    loadSecrets(['ANTHROPIC_API_KEY']);
    expect(redactSecrets('sk-ant-never-exempt-key')).toBe('[REDACTED]');
  });

  it('redacts CLAUDE_CODE_OAUTH_TOKEN even when passed as additionalSafeVars', () => {
    writeEnv('CLAUDE_CODE_OAUTH_TOKEN=oauth-never-exempt-tok');
    loadSecrets(['CLAUDE_CODE_OAUTH_TOKEN']);
    expect(redactSecrets('oauth-never-exempt-tok')).toBe('[REDACTED]');
  });

  it('redacts OPENAI_API_KEY even when passed as additionalSafeVars', () => {
    writeEnv('OPENAI_API_KEY=sk-openai-never-exempt');
    loadSecrets(['OPENAI_API_KEY']);
    expect(redactSecrets('sk-openai-never-exempt')).toBe('[REDACTED]');
  });

  it('redacts DASHBOARD_SECRET even when passed as additionalSafeVars', () => {
    writeEnv('DASHBOARD_SECRET=dash-secret-never-exempt');
    loadSecrets(['DASHBOARD_SECRET']);
    expect(redactSecrets('dash-secret-never-exempt')).toBe('[REDACTED]');
  });
});
