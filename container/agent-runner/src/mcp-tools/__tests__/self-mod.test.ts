/**
 * Phase 5C-02 — schema + payload-builder tests for the self-mod MCP tools.
 *
 * These cover the validation matrix the agent will hit before any IPC file
 * is written. The full host-side validation re-runs on the receiving side
 * as defense in depth (`src/permissions/install-packages.ts` etc.) — so a
 * bug here would be caught before any state mutation, but tests pin the
 * shape so the contract between container + host stays in sync.
 */
import { describe, it, expect } from 'vitest';

import {
  APT_PACKAGE_RE,
  NPM_PACKAGE_RE,
  MAX_PACKAGES,
  addMcpServerInput,
  buildAddMcpServerPayload,
  buildInstallPackagesPayload,
  installPackagesInput,
} from '../self-mod.js';

// ── install_packages schema ────────────────────────────────────────────────

describe('installPackagesInput zod schema', () => {
  it('accepts the minimal happy-path (only reason)', () => {
    const parsed = installPackagesInput.parse({ reason: 'r' });
    expect(parsed.reason).toBe('r');
    expect(parsed.apt).toBeUndefined();
    expect(parsed.npm).toBeUndefined();
  });

  it('accepts arrays of package names', () => {
    const parsed = installPackagesInput.parse({
      apt: ['curl'],
      npm: ['typescript'],
      reason: 'tools',
    });
    expect(parsed.apt).toEqual(['curl']);
    expect(parsed.npm).toEqual(['typescript']);
  });

  it('rejects payload missing required reason', () => {
    expect(() => installPackagesInput.parse({ apt: ['curl'] })).toThrow();
  });

  it('rejects non-string entries in apt array', () => {
    expect(() =>
      installPackagesInput.parse({ apt: [123], reason: 'r' }),
    ).toThrow();
  });
});

// ── install_packages validation ────────────────────────────────────────────

describe('buildInstallPackagesPayload', () => {
  const ctx = { groupFolder: 'main', isMain: true, now: new Date('2026-04-26T12:00:00.000Z') };

  it('returns ok=true for a happy-path apt-only request', () => {
    const result = buildInstallPackagesPayload({ apt: ['curl'], reason: 'tools' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      type: 'install_packages',
      apt: ['curl'],
      npm: [],
      reason: 'tools',
      groupFolder: 'main',
      isMain: true,
      timestamp: '2026-04-26T12:00:00.000Z',
    });
  });

  it('returns ok=true for a happy-path npm-only request', () => {
    const result = buildInstallPackagesPayload({ npm: ['ripgrep'], reason: 'tools' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.apt).toEqual([]);
    expect(result.payload.npm).toEqual(['ripgrep']);
  });

  it('rejects empty request (no apt, no npm)', () => {
    const result = buildInstallPackagesPayload({ reason: 'r' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/at least one/i);
  });

  it('rejects request that exceeds MAX_PACKAGES', () => {
    const many = Array.from({ length: MAX_PACKAGES + 1 }, (_, i) => `pkg${i}`);
    const result = buildInstallPackagesPayload({ apt: many, reason: 'r' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/too many/i);
  });

  it('rejects invalid apt names', () => {
    const cases = [
      'curl=1.0', // version spec
      'CURL', // uppercase
      'curl;rm -rf /', // shell metacharacters
      '../etc/passwd', // path traversal
      '', // empty
    ];
    for (const bad of cases) {
      const result = buildInstallPackagesPayload({ apt: [bad], reason: 'r' }, ctx);
      expect(result.ok, `should reject "${bad}"`).toBe(false);
      if (result.ok) continue;
      expect(result.error).toMatch(/invalid apt/i);
    }
  });

  it('rejects invalid npm names', () => {
    const cases = [
      'foo@1.0.0', // version spec
      'FOO', // uppercase
      'foo bar', // space
      'foo;cat /etc/passwd', // shell metacharacters
    ];
    for (const bad of cases) {
      const result = buildInstallPackagesPayload({ npm: [bad], reason: 'r' }, ctx);
      expect(result.ok, `should reject "${bad}"`).toBe(false);
      if (result.ok) continue;
      expect(result.error).toMatch(/invalid npm/i);
    }
  });

  it('accepts scoped npm package names', () => {
    const result = buildInstallPackagesPayload(
      { npm: ['@anthropic-ai/sdk'], reason: 'sdk' },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('preserves order of apt then npm in the payload', () => {
    const result = buildInstallPackagesPayload(
      { apt: ['curl', 'git'], npm: ['typescript'], reason: 'r' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.apt).toEqual(['curl', 'git']);
    expect(result.payload.npm).toEqual(['typescript']);
  });

  it('payload is JSON-serialisable', () => {
    const result = buildInstallPackagesPayload({ apt: ['curl'], reason: 'r' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const round = JSON.parse(JSON.stringify(result.payload));
    expect(round).toEqual(result.payload);
  });
});

// ── apt / npm regex sanity ──────────────────────────────────────────────────

describe('package-name regexes', () => {
  it('APT_PACKAGE_RE accepts known-good names', () => {
    for (const name of ['curl', 'libssl-dev', 'python3.11', 'g++', 'lib_a', 'a', 'a1']) {
      expect(APT_PACKAGE_RE.test(name), name).toBe(true);
    }
  });

  it('APT_PACKAGE_RE rejects shell metacharacters and uppercase', () => {
    for (const bad of ['Curl', 'a;b', 'a b', '../etc', '$(echo)', '`x`', '']) {
      expect(APT_PACKAGE_RE.test(bad), bad).toBe(false);
    }
  });

  it('NPM_PACKAGE_RE accepts known-good names', () => {
    for (const name of [
      'typescript',
      '@scope/pkg',
      'foo-bar',
      'foo.bar',
      '@anthropic-ai/sdk',
    ]) {
      expect(NPM_PACKAGE_RE.test(name), name).toBe(true);
    }
  });

  it('NPM_PACKAGE_RE rejects version specs and metacharacters', () => {
    for (const bad of ['foo@1.0.0', 'foo bar', 'FOO', '@scope/PKG', 'foo;bar']) {
      expect(NPM_PACKAGE_RE.test(bad), bad).toBe(false);
    }
  });
});

// ── add_mcp_server schema + builder ────────────────────────────────────────

describe('addMcpServerInput zod schema', () => {
  it('accepts the minimal happy-path (name + command only)', () => {
    const parsed = addMcpServerInput.parse({ name: 'srv', command: 'npx' });
    expect(parsed.name).toBe('srv');
    expect(parsed.command).toBe('npx');
    expect(parsed.args).toBeUndefined();
    expect(parsed.env).toBeUndefined();
  });

  it('accepts args + env', () => {
    const parsed = addMcpServerInput.parse({
      name: 'srv',
      command: 'npx',
      args: ['-y', '@some/mcp'],
      env: { TOKEN: 'x' },
    });
    expect(parsed.args).toEqual(['-y', '@some/mcp']);
    expect(parsed.env).toEqual({ TOKEN: 'x' });
  });

  it('rejects empty name', () => {
    expect(() => addMcpServerInput.parse({ name: '', command: 'npx' })).toThrow();
  });

  it('rejects empty command', () => {
    expect(() => addMcpServerInput.parse({ name: 'srv', command: '' })).toThrow();
  });

  it('rejects missing fields', () => {
    expect(() => addMcpServerInput.parse({ name: 'srv' })).toThrow();
    expect(() => addMcpServerInput.parse({ command: 'npx' })).toThrow();
  });
});

describe('buildAddMcpServerPayload', () => {
  const ctx = { groupFolder: 'main', isMain: false, now: new Date('2026-04-26T12:00:00.000Z') };

  it('returns ok=true for a happy-path request', () => {
    const result = buildAddMcpServerPayload(
      { name: 'srv', command: 'npx', args: ['-y', '@some/mcp'], env: { TOKEN: 'x' } },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      type: 'add_mcp_server',
      name: 'srv',
      command: 'npx',
      args: ['-y', '@some/mcp'],
      env: { TOKEN: 'x' },
      groupFolder: 'main',
      isMain: false,
      timestamp: '2026-04-26T12:00:00.000Z',
    });
  });

  it('defaults args + env to empty when omitted', () => {
    const result = buildAddMcpServerPayload({ name: 'srv', command: 'npx' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.args).toEqual([]);
    expect(result.payload.env).toEqual({});
  });

  it('rejects builder-level missing fields (defense-in-depth past zod)', () => {
    // The zod schema would catch this on real callers, but the builder is
    // still a separate guard for tests / direct callers that bypass zod.
    const r1 = buildAddMcpServerPayload({ name: '', command: 'npx' } as never, ctx);
    expect(r1.ok).toBe(false);

    const r2 = buildAddMcpServerPayload({ name: 'srv', command: '' } as never, ctx);
    expect(r2.ok).toBe(false);
  });

  it('payload is JSON-serialisable', () => {
    const result = buildAddMcpServerPayload({ name: 'srv', command: 'npx' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const round = JSON.parse(JSON.stringify(result.payload));
    expect(round).toEqual(result.payload);
  });
});
