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
  buildCreateSkillPluginPayload,
  type CreateSkillPluginInput,
  RESERVED_ENV_VAR_NAMES,
  RESERVED_ENV_VAR_PREFIXES,
  ALLOWED_CHANNEL_NAMES,
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

// ── create_skill_plugin ────────────────────────────────────────────────────

describe('buildCreateSkillPluginPayload', () => {
  const baseCtx = { groupFolder: 'main', isMain: true, now: new Date('2026-04-27T12:00:00Z') };

  function skillOnlyInput(overrides: Partial<CreateSkillPluginInput> = {}): CreateSkillPluginInput {
    return {
      name: 'weather',
      description: 'Look up weather forecasts',
      archetype: 'skill-only',
      pluginJson: {
        name: 'weather',
        description: 'Look up weather forecasts',
        version: '1.0.0',
        channels: ['*'],
        groups: ['*'],
      },
      containerSkillMd: '# Weather\n\nUse curl to fetch from wttr.in',
      ...overrides,
    };
  }

  it('happy path: skill-only with no env vars', () => {
    const result = buildCreateSkillPluginPayload(skillOnlyInput(), baseCtx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.type).toBe('create_skill_plugin');
    expect(result.payload.name).toBe('weather');
    expect(result.payload.archetype).toBe('skill-only');
    expect(result.payload.groupFolder).toBe('main');
    expect(result.payload.timestamp).toBe('2026-04-27T12:00:00.000Z');
  });

  it('happy path: mcp archetype with mcpJson and env vars', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({
        archetype: 'mcp',
        pluginJson: {
          name: 'github',
          description: 'GitHub via MCP',
          version: '1.0.0',
          containerEnvVars: ['GH_TOKEN'],
          channels: ['*'],
          groups: ['*'],
        },
        mcpJson: '{"mcpServers":{"github":{"command":"npx","args":["-y","@some/gh-mcp"]}}}',
        envVarValues: { GH_TOKEN: 'ghp_secret' },
      }),
      baseCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.archetype).toBe('mcp');
    expect(result.payload.envVarValues).toEqual({ GH_TOKEN: 'ghp_secret' });
  });

  it('rejects invalid name format', () => {
    const result = buildCreateSkillPluginPayload(skillOnlyInput({ name: 'Weather' }), baseCtx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/name/);
  });

  it('rejects name longer than 31 chars', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({ name: 'a'.repeat(32) }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects description longer than 200 chars', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({ description: 'x'.repeat(201) }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects archetype not in enum', () => {
    const result = buildCreateSkillPluginPayload(
      // @ts-expect-error testing runtime guard
      skillOnlyInput({ archetype: 'host-hook' }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/archetype/);
  });

  it('rejects pluginJson.hooks if non-empty', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({
        pluginJson: {
          name: 'x',
          description: 'd',
          version: '1.0.0',
          // @ts-expect-error testing runtime guard
          hooks: ['onStartup'],
          channels: ['*'],
          groups: ['*'],
        },
      }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/hooks/);
  });

  it('rejects pluginJson.containerHooks if non-empty', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({
        pluginJson: {
          name: 'x',
          description: 'd',
          version: '1.0.0',
          // @ts-expect-error testing runtime guard
          containerHooks: ['hooks/x.js'],
          channels: ['*'],
          groups: ['*'],
        },
      }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/containerHooks/);
  });

  it('rejects pluginJson.dependencies = true', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({
        pluginJson: {
          name: 'x',
          description: 'd',
          version: '1.0.0',
          // @ts-expect-error testing runtime guard
          dependencies: true,
          channels: ['*'],
          groups: ['*'],
        },
      }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/dependencies/);
  });

  it('rejects containerSkillMd over 20 KB', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({ containerSkillMd: 'a'.repeat(20001) }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/containerSkillMd/);
  });

  it('rejects mcpJson over 4 KB', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({ archetype: 'mcp', mcpJson: 'a'.repeat(4097) }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/mcpJson/);
  });

  it('rejects malformed env var name', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({ envVarValues: { 'lower_case': 'x' } }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/env var/i);
  });

  it('rejects reserved env var names', () => {
    for (const name of RESERVED_ENV_VAR_NAMES) {
      const result = buildCreateSkillPluginPayload(
        skillOnlyInput({ envVarValues: { [name]: 'x' } }),
        baseCtx,
      );
      expect(result.ok, name).toBe(false);
    }
  });

  it('rejects env var with reserved prefix (NANOCLAW_*)', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({ envVarValues: { NANOCLAW_DATA_DIR: 'x' } }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects groups scope that is neither ["*"] nor [groupFolder]', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({
        pluginJson: {
          name: 'x',
          description: 'd',
          version: '1.0.0',
          channels: ['*'],
          groups: ['other-group'],
        },
      }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/groups/);
  });

  it('accepts groups scope = [groupFolder]', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({
        pluginJson: {
          name: 'x',
          description: 'd',
          version: '1.0.0',
          channels: ['*'],
          groups: ['main'],
        },
      }),
      baseCtx,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects unknown channel name', () => {
    const result = buildCreateSkillPluginPayload(
      skillOnlyInput({
        pluginJson: {
          name: 'x',
          description: 'd',
          version: '1.0.0',
          channels: ['ircchat'],
          groups: ['*'],
        },
      }),
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/channel/);
  });

  it('exports stable allowlist constants', () => {
    expect([...RESERVED_ENV_VAR_NAMES].sort()).toEqual(
      ['ANTHROPIC_API_KEY', 'ASSISTANT_NAME', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_MODEL', 'HOME', 'PATH', 'PWD', 'SHELL', 'USER'].sort(),
    );
    expect([...RESERVED_ENV_VAR_PREFIXES].sort()).toEqual(['DYLD_', 'LD_', 'NANOCLAW_', 'NODE_'].sort());
    expect([...ALLOWED_CHANNEL_NAMES].sort()).toEqual(
      ['*', 'discord', 'slack', 'telegram', 'webhook', 'whatsapp'].sort(),
    );
  });

  it('rejects dangerous env var prefixes (LD_, DYLD_, NODE_)', () => {
    for (const name of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_PATH']) {
      const result = buildCreateSkillPluginPayload(
        skillOnlyInput({ envVarValues: { [name]: 'x' } }),
        baseCtx,
      );
      expect(result.ok, name).toBe(false);
    }
  });
});
