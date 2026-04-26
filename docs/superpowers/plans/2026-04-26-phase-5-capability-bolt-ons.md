# Phase 5: Capability bolt-ons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task.

**Goal:** Ship five sub-phases (5A → 5B → 5C → 5D → 5E) on top of Phase 4 RBAC + approval primitive + Phase 4.5 pnpm. After Phase 5, agents can self-install packages (with admin approval), self-register MCP servers, soft-pause the host, and (admin-only) provision peer agent groups, all on v1's per-group container model. The provider seam is in place for future Codex/OpenCode/Ollama plugins.

**Architecture:** Five independent commits-clusters, each landed as one PR-equivalent. Sub-phase ordering is a hard dependency chain: 5A (provider seam) → 5B (per-group images, depends on no other 5x but ordered for clean review) → 5C (self-mod, depends on 5B) → 5D (lifecycle, depends only on Phase 4) → 5E (create_agent, depends only on Phase 4). Sub-phases 5D and 5E can be parallelized after 5C (use `git worktree` per memory note).

**Tech Stack:** Node 22, TypeScript 5.9, vitest 4, better-sqlite3 11, pino 9. **pnpm** (root after Phase 4.5), **npm** in `container/agent-runner/` (v1's choice; agent-runner stays npm-on-Node, NOT bun like v2). `pnpm test`, `pnpm typecheck`, `pnpm install` at root; `npm test`, `npm run typecheck`, `npm install` in `container/agent-runner/`. Lockfiles: `pnpm-lock.yaml` (root), `package-lock.json` (agent-runner).

**Spec input:** `/data/nanotars/docs/superpowers/specs/2026-04-26-phase-5-capability-bolt-ons.md`

---

## CONTRIBUTE upstream PRs — out of scope

CONTRIBUTE-class items that surface during Phase 5 (e.g. v1's `emergencyStop` race-window analysis, v1's plugin-Dockerfile.partial path-traversal hardening) are tracked separately as PRs to qwibitai/nanoclaw. Phase 5 does not block on them.

---

## Items deferred from Phase 5

- Cross-container peer-agent messaging (`agent_destinations`, `channel_type='agent'`, `send_to_agent` MCP tool) — Phase 7.
- Per-session containers + two-DB IPC — Phase 6.
- Heartbeat-driven stuck detection — Phase 6.
- Real non-Claude provider implementations (Codex, OpenCode, Ollama) — separate plugin work post-Phase-5.
- Provider-aware session_state continuation namespacing — paired with first non-Claude provider.
- Per-group image GC (auto-prune old images) — operational follow-up; Phase 5 ships LABEL only.
- `/wire` admin command auto-creation as part of `create_agent` — operational helper, Phase 6 / post-5E.

---

## Pre-flight verification (whole phase)

- [ ] **Step 1: Verify v1-archive clean tree, Phase 4 + 4.5 complete**

```
cd /data/nanotars && git status --short --branch
cd /data/nanotars && git log --oneline -10
```

Expected: clean tree on v1-archive. HEAD includes the Phase 4D D7 final commit (h1 fallback fix or later) + the Phase 4.5 pnpm landing commits. `git log --oneline | grep -iE "phase 4(\\.5|d|c|b|a)" | wc -l` ≥ 8 (at least one commit per sub-phase).

- [ ] **Step 2: Verify Phase 4 exports needed by Phase 5 are present**

```
cd /data/nanotars && grep -nE "requestApproval|registerApprovalHandler|pickApprover|isAdminOfAgentGroup|isOwner|isGlobalAdmin|addAgentGroupMember|createAgentGroup|getAgentGroupById" src/permissions/*.ts src/db/agent-groups.ts | head -30
```

Each function defined. If any missing, surface BLOCKED — Phase 5 cannot land without them.

- [ ] **Step 3: Verify baseline test counts**

```
cd /data/nanotars && pnpm test 2>&1 | tail -5         # ~600+ after Phase 4D
cd /data/nanotars/container/agent-runner && npm test 2>&1 | tail -5   # ~30+
```

Note exact baseline numbers; Phase 5 will add roughly 80-120 host-side tests + 20-30 container-side tests across all five sub-phases.

- [ ] **Step 4: Typecheck clean**

```
cd /data/nanotars && pnpm typecheck
cd /data/nanotars/container/agent-runner && npm run typecheck
```

- [ ] **Step 5: Verify Phase 4.5 pnpm migration landed**

```
cd /data/nanotars && ls pnpm-workspace.yaml pnpm-lock.yaml 2>/dev/null
cd /data/nanotars && grep -E "^minimumReleaseAge|^onlyBuiltDependencies" pnpm-workspace.yaml
```

Both files present + `minimumReleaseAge: 4320` and `onlyBuiltDependencies` allowlist present. If not, BLOCKED — Phase 5 self-mod assumes pnpm release-age policy.

- [ ] **Step 6: Confirm container-runner test runtime**

```
cd /data/nanotars/container/agent-runner && cat package.json | grep -E '"(test|typecheck)"'
```

Expected: `"test": "vitest run"` (or similar — v1 stays on vitest for the agent-runner). Plan default: vitest. If it's bun:test (it isn't on v1-archive — verify), flip the imports throughout.

---

# Sub-phase 5A — Provider abstraction seam

**Goal:** Introduce `AgentProvider` interface in agent-runner, register the existing Anthropic SDK call as the `claude` provider, and add the host-side `provider-container-registry` for non-default providers. Plugin loader gains `manifest.agentProvider` flag handling. Zero behavior change for existing groups (default provider stays Claude).

**Sub-phase tasks:** 5A-00 (preflight) → 5A-01 (interface + types) → 5A-02 (registry + factory) → 5A-03 (claude impl) → 5A-04 (mock impl + tests) → 5A-05 (host-side container-registry) → 5A-06 (plugin-loader integration) → 5A-07 (wire SDK call site behind seam) → 5A-08 (final review).

## 5A-00: Preflight — landed-state documentation

**Reviewer dispatch:** NO (read-only verification).

- [ ] **Step 1: Document the actual state**

```
cd /data/nanotars
git rev-parse HEAD                                       # capture starting SHA
sqlite3 data/nanotars.db "PRAGMA table_info(agent_groups)"  # verify agent_provider col
grep -n "query(" container/agent-runner/src/index.ts | head -10  # confirm single call site
grep -rn "agentProvider\|AgentProvider\|provider-registry" src/ container/agent-runner/src/ 2>&1 | head -10  # confirm namespace free
```

- [ ] **Step 2: Capture in commit message of 5A-01**

The first 5A code commit (5A-01) embeds these outputs in its commit body so the actual landed state is the schema-of-record (Phase 4 D1 lesson).

## 5A-01: Container-side AgentProvider type definitions

**Reviewer dispatch:** YES — IPC contract + agent-runner schema.

**Files:**
- New: `/data/nanotars/container/agent-runner/src/providers/types.ts`

- [ ] **Step 1: Write the types file**

```ts
// container/agent-runner/src/providers/types.ts

/**
 * Provider abstraction seam — Phase 5A.
 *
 * The existing single-call-to-claude-sdk path in container/agent-runner/src/index.ts
 * gets wrapped into the `claude` provider's query(). Future Codex/OpenCode/Ollama
 * providers ship as plugins (v1) with their own AgentProvider impl.
 *
 * Resolution order at startup: process.env.NANOCLAW_AGENT_PROVIDER ?? 'claude'.
 * The host writes NANOCLAW_AGENT_PROVIDER from agent_groups.agent_provider
 * (or 'claude' fallback) at container spawn.
 */

export interface AgentProvider {
  readonly supportsNativeSlashCommands: boolean;
  query(input: QueryInput): AgentQuery;
  isSessionInvalid(err: unknown): boolean;
}

export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
}

export interface QueryInput {
  prompt: string;
  continuation?: string;
  cwd: string;
  systemContext?: { instructions?: string };
  modelOverride?: string;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentQuery {
  push(message: string): void;
  end(): void;
  events: AsyncIterable<ProviderEvent>;
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  | { type: 'activity' };
```

- [ ] **Step 2: Run typecheck**

```
cd /data/nanotars/container/agent-runner && npm run typecheck
```

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add container/agent-runner/src/providers/types.ts
cd /data/nanotars && git commit -m "$(cat <<'EOF'
feat(5a): AgentProvider interface + QueryInput shape

Phase 5A foundation. The interface is intentionally narrow — query()
returning an AgentQuery handle whose `events` async-iterable yields
ProviderEvent unions. Mirrors v2's contract verbatim
(/data/nanoclaw-v2/container/agent-runner/src/providers/types.ts).

No callers yet. 5A-02 adds the registry; 5A-03 wraps the existing
Anthropic SDK call as the `claude` provider; 5A-07 swaps the call site.

Spec: docs/superpowers/specs/2026-04-26-phase-5-capability-bolt-ons.md (5A)

Preflight state captured at HEAD <SHA from 5A-00>:
- agent_groups.agent_provider exists (Phase 4A migration 008)
- container/agent-runner/src/index.ts:567-606 = single SDK call site
- providers/ namespace was free (no prior modules)
EOF
)"
```

## 5A-02: Provider registry + factory

**Reviewer dispatch:** NO (single-file mechanical, registry pattern).

**Files:**
- New: `/data/nanotars/container/agent-runner/src/providers/provider-registry.ts`
- New: `/data/nanotars/container/agent-runner/src/providers/factory.ts`
- New: `/data/nanotars/container/agent-runner/src/providers/index.ts` (barrel)
- New: `/data/nanotars/container/agent-runner/src/providers/__tests__/provider-registry.test.ts`

- [ ] **Step 1: Write provider-registry.ts**

```ts
// container/agent-runner/src/providers/provider-registry.ts
import type { AgentProvider, ProviderOptions } from './types.js';

export type ProviderFactory = (options: ProviderOptions) => AgentProvider;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  if (registry.has(name)) throw new Error(`Provider already registered: ${name}`);
  registry.set(name, factory);
}

export function getProviderFactory(name: string): ProviderFactory {
  const factory = registry.get(name);
  if (!factory) {
    const known = [...registry.keys()].join(', ') || '(none)';
    throw new Error(`Unknown provider: ${name}. Registered: ${known}`);
  }
  return factory;
}

export function listProviderNames(): string[] {
  return [...registry.keys()];
}

/** @internal — for tests only. */
export function _clearProviderRegistry(): void {
  registry.clear();
}
```

- [ ] **Step 2: Write factory.ts**

```ts
// container/agent-runner/src/providers/factory.ts
import type { AgentProvider, ProviderOptions } from './types.js';
import { getProviderFactory } from './provider-registry.js';

export type ProviderName = string;

export function createProvider(name: ProviderName, options: ProviderOptions = {}): AgentProvider {
  return getProviderFactory(name)(options);
}

export function resolveProviderNameFromEnv(): ProviderName {
  return process.env.NANOCLAW_AGENT_PROVIDER || 'claude';
}
```

- [ ] **Step 3: Write barrel index.ts (empty for now; 5A-03 imports the claude side-effect)**

```ts
// container/agent-runner/src/providers/index.ts
// Barrel: importing this file triggers all provider self-registrations.
// Each provider module's import has the side effect of `registerProvider(name, factory)`.
import './claude.js';   // populated in 5A-03
```

- [ ] **Step 4: Tests**

```ts
// container/agent-runner/src/providers/__tests__/provider-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider, getProviderFactory, listProviderNames, _clearProviderRegistry,
} from '../provider-registry.js';
import type { AgentProvider } from '../types.js';

const fakeProvider: AgentProvider = {
  supportsNativeSlashCommands: false,
  query: () => ({ push() {}, end() {}, events: (async function*() {})(), abort() {} }),
  isSessionInvalid: () => false,
};

describe('provider-registry', () => {
  beforeEach(() => _clearProviderRegistry());

  it('registers + resolves by name', () => {
    registerProvider('fake', () => fakeProvider);
    expect(getProviderFactory('fake')()).toBe(fakeProvider);
  });

  it('throws on duplicate registration', () => {
    registerProvider('fake', () => fakeProvider);
    expect(() => registerProvider('fake', () => fakeProvider)).toThrow(/already registered/);
  });

  it('throws on unknown name with helpful list', () => {
    registerProvider('fake', () => fakeProvider);
    expect(() => getProviderFactory('missing')).toThrow(/Unknown provider: missing/);
    expect(() => getProviderFactory('missing')).toThrow(/Registered: fake/);
  });

  it('listProviderNames returns registered names', () => {
    registerProvider('a', () => fakeProvider);
    registerProvider('b', () => fakeProvider);
    expect(listProviderNames().sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 5: Run tests + typecheck**

```
cd /data/nanotars/container/agent-runner && npm run typecheck && npm test
```

Expected: 4 new tests pass.

- [ ] **Step 6: Commit**

```
cd /data/nanotars && git add container/agent-runner/src/providers/
cd /data/nanotars && git commit -m "feat(5a): provider registry + factory"
```

## 5A-03: Claude provider implementation (wraps existing SDK call)

**Reviewer dispatch:** YES — wraps a load-bearing IPC call site, even though current behavior unchanged.

**Files:**
- New: `/data/nanotars/container/agent-runner/src/providers/claude.ts`
- Modify: `/data/nanotars/container/agent-runner/src/providers/index.ts` (already imports `./claude.js`)

- [ ] **Step 1: Read the existing SDK call site**

```
sed -n '550,620p' /data/nanotars/container/agent-runner/src/index.ts
```

Capture the exact `query({prompt, options:{...}})` shape. The `claude.ts` impl wraps it.

- [ ] **Step 2: Write claude.ts**

The implementation wraps the existing single-call shape:

```ts
// container/agent-runner/src/providers/claude.ts
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider, AgentQuery, McpServerConfig, ProviderEvent,
  ProviderOptions, QueryInput,
} from './types.js';

// Lazy import: only require @anthropic-ai/claude-code when this provider is
// actually used. Avoids loading the SDK in tests that mock at the registry level.
async function importSdk() {
  return await import('@anthropic-ai/claude-code');
}

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private options: ProviderOptions;

  constructor(options: ProviderOptions) {
    this.options = options;
  }

  query(input: QueryInput): AgentQuery {
    // Mirrors v2's claude.ts:240-345 plus v1's existing shape from
    // container/agent-runner/src/index.ts:567-606.
    const events: ProviderEvent[] = [];
    let aborted = false;
    const yieldEvent = (e: ProviderEvent) => events.push(e);

    const eventsIter: AsyncIterable<ProviderEvent> = {
      [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
        let idx = 0;
        return {
          async next() {
            if (aborted) return { done: true, value: undefined as any };
            // Pump the buffer until exhausted; the underlying SDK feeds it.
            while (idx >= events.length) {
              await new Promise((r) => setTimeout(r, 50));
              if (aborted) return { done: true, value: undefined as any };
            }
            return { done: false, value: events[idx++] };
          },
        };
      },
    };

    // Drive the SDK in the background, push events as they arrive.
    (async () => {
      const { query } = await importSdk();
      try {
        const sdkOpts: Record<string, unknown> = {
          mcpServers: this.options.mcpServers,
          additionalDirectories: this.options.additionalDirectories,
          systemPrompt: input.systemContext?.instructions
            ? { type: 'append', text: input.systemContext.instructions }
            : undefined,
        };
        if (input.modelOverride) sdkOpts.model = input.modelOverride;
        if (input.continuation) sdkOpts.resume = input.continuation;

        const result = await query({ prompt: input.prompt, options: sdkOpts });
        // SDK returns a result object — adapt to ProviderEvent stream.
        // (full SDK adaptation logic mirrors v2 claude.ts:299-333; copy verbatim
        //  with adjustments for the v1 SDK version + no two-DB awareness.)
        yieldEvent({ type: 'init', continuation: result.session_id ?? '' });
        yieldEvent({ type: 'activity' });
        yieldEvent({ type: 'result', text: result.text ?? null });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yieldEvent({ type: 'error', message: msg, retryable: false });
      }
    })().catch(() => {});

    return {
      push(_message: string): void { /* v1's path is single-shot today */ },
      end(): void {},
      events: eventsIter,
      abort(): void { aborted = true; },
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /no transcript found|session.*not found|continuation.*invalid/i.test(msg);
  }
}

registerProvider('claude', (options) => new ClaudeProvider(options));
```

**Note for implementer:** the `eventsIter` shape above is a sketch. The actual implementation copies v2's claude.ts wrapping (which uses an internal queue + condition variable). Implementer reads `/data/nanoclaw-v2/container/agent-runner/src/providers/claude.ts:240-345` for the production shape.

- [ ] **Step 3: Smoke test (mocked SDK)**

```ts
// container/agent-runner/src/providers/__tests__/claude.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ClaudeProvider } from '../claude.js';

vi.mock('@anthropic-ai/claude-code', () => ({
  query: async ({ prompt }: { prompt: string }) => ({
    session_id: 'mock-session-1',
    text: `Echo: ${prompt}`,
  }),
}));

describe('ClaudeProvider', () => {
  it('streams init + result events for a single prompt', async () => {
    const provider = new ClaudeProvider({ assistantName: 'TARS' });
    const q = provider.query({ prompt: 'hello', cwd: '/workspace/group' });
    const collected: string[] = [];
    for await (const e of q.events) {
      collected.push(e.type);
      if (e.type === 'result') break;
    }
    expect(collected).toContain('init');
    expect(collected).toContain('result');
  });

  it('isSessionInvalid matches typical SDK error strings', () => {
    const p = new ClaudeProvider({});
    expect(p.isSessionInvalid(new Error('no transcript found for session abc'))).toBe(true);
    expect(p.isSessionInvalid(new Error('rate limited'))).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests + typecheck**

```
cd /data/nanotars/container/agent-runner && npm run typecheck && npm test
```

- [ ] **Step 5: Commit**

```
cd /data/nanotars && git add container/agent-runner/src/providers/claude.ts container/agent-runner/src/providers/__tests__/claude.test.ts
cd /data/nanotars && git commit -m "feat(5a): claude provider impl wrapping the existing SDK call"
```

## 5A-04: Mock provider for testing

**Reviewer dispatch:** NO (test-only).

**Files:**
- New: `/data/nanotars/container/agent-runner/src/providers/mock.ts`

- [ ] **Step 1: Write mock.ts**

```ts
// container/agent-runner/src/providers/mock.ts
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  constructor(private options: ProviderOptions) {}

  query(input: QueryInput): AgentQuery {
    const events: ProviderEvent[] = [
      { type: 'init', continuation: 'mock-session' },
      { type: 'activity' },
      { type: 'result', text: `MOCK: ${input.prompt}` },
    ];
    return {
      push() {},
      end() {},
      events: (async function* () { for (const e of events) yield e; })(),
      abort() {},
    };
  }
  isSessionInvalid(): boolean { return false; }
}

registerProvider('mock', (options) => new MockProvider(options));
```

- [ ] **Step 2: Add to barrel**

```ts
// container/agent-runner/src/providers/index.ts
import './claude.js';
import './mock.js';
```

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add container/agent-runner/src/providers/mock.ts container/agent-runner/src/providers/index.ts
cd /data/nanotars && git commit -m "feat(5a): mock provider for tests"
```

## 5A-05: Host-side provider-container-registry

**Reviewer dispatch:** YES — touches container-runner spawn surface.

**Files:**
- New: `/data/nanotars/src/providers/provider-container-registry.ts`
- New: `/data/nanotars/src/providers/index.ts` (barrel)
- New: `/data/nanotars/src/providers/__tests__/provider-container-registry.test.ts`

- [ ] **Step 1: Write the registry**

```ts
// src/providers/provider-container-registry.ts
/**
 * Host-side provider container-config registry.
 *
 * Providers that need per-spawn host-side setup (extra mounts, env passthrough,
 * per-session directories) register a contribution function. The container-
 * runner resolves the agent group's agent_provider, looks up the registered fn,
 * and merges the returned mounts/env into the spawn args.
 *
 * Providers without host-side needs (claude, mock) don't appear here.
 *
 * Plugin-loader populates this registry at startup when it sees
 * manifest.agentProvider === true (5A-06).
 *
 * Mirrors v2's src/providers/provider-container-registry.ts.
 */

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface ProviderContainerContext {
  agentGroupId: string;
  groupFolder: string;
  hostEnv: NodeJS.ProcessEnv;
}

export interface ProviderContainerContribution {
  mounts?: VolumeMount[];
  env?: Record<string, string>;
}

export type ProviderContainerConfigFn = (ctx: ProviderContainerContext) => ProviderContainerContribution;

const registry = new Map<string, ProviderContainerConfigFn>();

export function registerProviderContainerConfig(name: string, fn: ProviderContainerConfigFn): void {
  if (registry.has(name)) throw new Error(`Provider container config already registered: ${name}`);
  registry.set(name, fn);
}

export function getProviderContainerConfig(name: string): ProviderContainerConfigFn | undefined {
  return registry.get(name);
}

export function listProviderContainerConfigNames(): string[] {
  return [...registry.keys()];
}

/** @internal — tests only */
export function _clearProviderContainerRegistry(): void {
  registry.clear();
}

/**
 * Resolve the effective provider name for an agent group.
 * Resolution order: agent_groups.agent_provider → 'claude'.
 * Future: per-session override when v1 grows per-session containers (Phase 6).
 */
export function resolveProviderName(agentGroupProvider: string | null | undefined): string {
  return agentGroupProvider || 'claude';
}
```

- [ ] **Step 2: Write the barrel**

```ts
// src/providers/index.ts
// Provider container-config barrel. Plugin-loader appends imports here for
// any plugin with manifest.agentProvider === true. Default providers (claude)
// don't register here — they have no host-side needs.
```

- [ ] **Step 3: Tests**

```ts
// src/providers/__tests__/provider-container-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProviderContainerConfig, getProviderContainerConfig, listProviderContainerConfigNames,
  resolveProviderName, _clearProviderContainerRegistry,
} from '../provider-container-registry.js';

describe('provider-container-registry', () => {
  beforeEach(() => _clearProviderContainerRegistry());

  it('registers + retrieves a config fn', () => {
    const fn = () => ({ mounts: [{ hostPath: '/tmp/x', containerPath: '/x', readonly: true }] });
    registerProviderContainerConfig('codex', fn);
    expect(getProviderContainerConfig('codex')).toBe(fn);
  });

  it('throws on duplicate registration', () => {
    registerProviderContainerConfig('codex', () => ({}));
    expect(() => registerProviderContainerConfig('codex', () => ({}))).toThrow(/already registered/);
  });

  it('returns undefined for unregistered providers', () => {
    expect(getProviderContainerConfig('claude')).toBeUndefined();
  });

  it('lists registered names', () => {
    registerProviderContainerConfig('a', () => ({}));
    registerProviderContainerConfig('b', () => ({}));
    expect(listProviderContainerConfigNames().sort()).toEqual(['a', 'b']);
  });

  it('resolveProviderName falls back to claude', () => {
    expect(resolveProviderName(null)).toBe('claude');
    expect(resolveProviderName(undefined)).toBe('claude');
    expect(resolveProviderName('')).toBe('claude');
    expect(resolveProviderName('codex')).toBe('codex');
  });
});
```

- [ ] **Step 4: Run tests**

```
cd /data/nanotars && pnpm typecheck && pnpm test src/providers
```

- [ ] **Step 5: Commit**

```
cd /data/nanotars && git add src/providers/
cd /data/nanotars && git commit -m "feat(5a): host-side provider-container-registry + resolveProviderName"
```

## 5A-06: Plugin-loader integration (manifest.agentProvider)

**Reviewer dispatch:** YES — extends plugin manifest contract.

**Files:**
- Modify: `/data/nanotars/src/plugin-types.ts`
- Modify: `/data/nanotars/src/plugin-loader.ts`
- Modify: `/data/nanotars/src/__tests__/plugin-loader.test.ts` (or create one)

- [ ] **Step 1: Add `agentProvider` flag to PluginManifest type**

In `/data/nanotars/src/plugin-types.ts`, add field:

```ts
export interface PluginManifest {
  // ... existing fields ...

  /**
   * Phase 5A: when true, this plugin contributes a non-default agent provider
   * (Codex, OpenCode, Ollama, etc.). Plugin's index.js MUST call
   * registerProviderContainerConfig(name, fn) at top level.
   */
  agentProvider?: boolean;
  /**
   * Phase 5A: provider name (e.g. 'codex'). Required when agentProvider is true.
   */
  agentProviderName?: string;
}
```

- [ ] **Step 2: Parse the new fields in `parseManifest`**

```ts
// src/plugin-loader.ts parseManifest()
return {
  // ... existing fields ...
  agentProvider: raw.agentProvider === true,
  agentProviderName: typeof raw.agentProviderName === 'string' ? raw.agentProviderName : undefined,
};
```

- [ ] **Step 3: When loading plugins, log + sanity-check agentProvider plugins**

```ts
// src/plugin-loader.ts loadPlugins()
for (const plugin of loaded) {
  if (plugin.manifest.agentProvider) {
    if (!plugin.manifest.agentProviderName) {
      logger.warn({ plugin: plugin.manifest.name }, 'agentProvider plugin missing agentProviderName; skipping registration');
      continue;
    }
    // The plugin's index.js is expected to have already called
    // registerProviderContainerConfig at module top-level. Verify.
    const { listProviderContainerConfigNames } = await import('./providers/provider-container-registry.js');
    if (!listProviderContainerConfigNames().includes(plugin.manifest.agentProviderName)) {
      logger.warn({
        plugin: plugin.manifest.name,
        expected: plugin.manifest.agentProviderName,
      }, 'agentProvider plugin loaded but container-registry has no matching entry');
    } else {
      logger.info({
        plugin: plugin.manifest.name,
        provider: plugin.manifest.agentProviderName,
      }, 'agent provider registered');
    }
  }
}
```

- [ ] **Step 4: Tests**

Add to `src/__tests__/plugin-loader.test.ts`:
- Manifest with `agentProvider: true` + `agentProviderName: 'codex'` parses correctly.
- Manifest with `agentProvider: true` but no name logs a warning.
- A plugin whose index.js calls `registerProviderContainerConfig('codex', fn)` is observable in the registry after `loadPlugins` completes.

- [ ] **Step 5: Run tests + typecheck**

```
cd /data/nanotars && pnpm typecheck && pnpm test src/__tests__/plugin-loader src/plugin-types
```

- [ ] **Step 6: Commit**

```
cd /data/nanotars && git add src/plugin-types.ts src/plugin-loader.ts src/__tests__/plugin-loader.test.ts
cd /data/nanotars && git commit -m "feat(5a): plugin-loader honors manifest.agentProvider flag"
```

## 5A-07: Wire SDK call site behind the provider seam

**Reviewer dispatch:** YES — reroutes the agent's main inference path.

**Files:**
- Modify: `/data/nanotars/container/agent-runner/src/index.ts` (the SDK call site, lines ~567-606)
- Modify: `/data/nanotars/src/container-runner.ts` (set `NANOCLAW_AGENT_PROVIDER` env var)

- [ ] **Step 1: Update the agent-runner main flow**

In `container/agent-runner/src/index.ts`, replace the single `query({prompt, options:{...}})` call with:

```ts
import './providers/index.js'; // triggers self-registrations
import { createProvider, resolveProviderNameFromEnv } from './providers/factory.js';

// ... where the SDK call was ...
const providerName = resolveProviderNameFromEnv();
const provider = createProvider(providerName, {
  assistantName: process.env.ASSISTANT_NAME,
  mcpServers: mcpServersConfig,                // existing var from earlier in file
  env: process.env,
  additionalDirectories: ['/workspace/group', '/workspace/extra'],
});

const q = provider.query({
  prompt: formattedPrompt,
  cwd: '/workspace/group',
  systemContext: { instructions: systemPromptAppend },
  modelOverride: input.model,
  continuation: input.sessionId,
});

for await (const event of q.events) {
  // existing event-handling logic, adapted from the provider event union:
  // 'init' → store sessionId; 'result' → emit final output; 'error' → propagate;
  // 'progress' / 'activity' → reset idle timer (matches existing onActivity wiring).
}
```

- [ ] **Step 2: Update host container-runner to set env var**

In `/data/nanotars/src/container-runner.ts` `buildContainerArgs` (or the env-file builder, depending on which path is in use):

```ts
// Phase 5A: pass the agent group's provider into the container.
// Resolution: agent_groups.agent_provider → 'claude'.
const providerName = group.agent_provider || 'claude';
args.push('-e', `NANOCLAW_AGENT_PROVIDER=${providerName}`);
```

Plus invoke any registered host-side contribution:

```ts
// 5A-05's resolveProviderName + getProviderContainerConfig
import {
  resolveProviderName, getProviderContainerConfig,
} from './providers/provider-container-registry.js';

const providerName = resolveProviderName(group.agent_provider);
const contributor = getProviderContainerConfig(providerName);
if (contributor) {
  const contrib = contributor({
    agentGroupId: group.id,
    groupFolder: group.folder,
    hostEnv: process.env,
  });
  for (const m of contrib.mounts ?? []) {
    args.push('-v', `${m.hostPath}:${m.containerPath}${m.readonly ? ':ro' : ''}`);
  }
  for (const [k, v] of Object.entries(contrib.env ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
}
```

- [ ] **Step 3: Smoke test the flow end-to-end**

```
cd /data/nanotars && pnpm test
cd /data/nanotars/container/agent-runner && npm test
```

Expected: nothing breaks. Existing behavior is preserved because `NANOCLAW_AGENT_PROVIDER=claude` (default), and `claudeProvider.query()` wraps the same SDK call.

- [ ] **Step 4: Manual smoke (optional)**

If running a live install, send a single message to a wired group and confirm the agent replies as before. Logs should show `[provider] claude` registration line.

- [ ] **Step 5: Commit**

```
cd /data/nanotars && git add container/agent-runner/src/index.ts src/container-runner.ts
cd /data/nanotars && git commit -m "feat(5a): wire SDK call behind provider seam"
```

## 5A-08: 5A final review + sub-phase commit

**Reviewer dispatch:** YES — sub-phase boundary.

- [ ] **Step 1: Run full test suite + typecheck**

```
cd /data/nanotars && pnpm typecheck && pnpm test
cd /data/nanotars/container/agent-runner && npm run typecheck && npm test
```

- [ ] **Step 2: Cross-tier review**

Use `superpowers:requesting-code-review` to dispatch a reviewer for the 5A commit range. Reviewer focus: provider seam preserves behavior, `NANOCLAW_AGENT_PROVIDER` env wiring is correct, registry side-effect imports fire in the right order.

- [ ] **Step 3: Address review feedback (if any)**

- [ ] **Step 4: Tag sub-phase complete**

```
cd /data/nanotars && git log --oneline -10   # confirm 5A commits
```

---

# Sub-phase 5B — Per-agent-group image build

**Goal:** Add `generateAgentGroupDockerfile` (pure) + `buildAgentGroupImage` (does IO) on host. Container-runner consumes `container_config.imageTag` with `CONTAINER_IMAGE` fallback. Manual `/rebuild-image` admin command (5C will trigger programmatically).

**Sub-phase tasks:** 5B-00 (preflight) → 5B-01 (ContainerConfig type extension) → 5B-02 (generateAgentGroupDockerfile) → 5B-03 (buildAgentGroupImage) → 5B-04 (container-runner imageTag fallback) → 5B-05 (/rebuild-image command) → 5B-06 (final review).

## 5B-00: Preflight

**Reviewer dispatch:** NO.

- [ ] **Step 1: Document state**

```
cd /data/nanotars
git rev-parse HEAD
sqlite3 data/nanotars.db "PRAGMA table_info(agent_groups)" | grep container_config   # confirm TEXT col
grep -n "CONTAINER_IMAGE" src/config.ts src/container-runner.ts
./container/build.sh && docker images | grep nanoclaw-agent  # confirm base image works
```

- [ ] **Step 2: Capture in 5B-01 commit body**

## 5B-01: Extend ContainerConfig type

**Reviewer dispatch:** NO (single-file mechanical type addition).

**Files:**
- Modify: `/data/nanotars/src/types.ts`
- New: `/data/nanotars/src/__tests__/container-config-shape.test.ts`

- [ ] **Step 1: Extend `ContainerConfig`**

```ts
// src/types.ts
export interface ContainerConfig {
  // existing
  additionalMounts?: AdditionalMount[];
  timeout?: number;

  // Phase 5B
  packages?: { apt: string[]; npm: string[] };
  /**
   * Project-relative paths to per-group Dockerfile.partial fragments. Stack
   * on top of the base image (which already has plugin partials baked in).
   * HOST-MANAGED: agents cannot mutate this via self-mod. Only an operator
   * with file-system access can edit container_config.dockerfilePartials.
   */
  dockerfilePartials?: string[];
  /**
   * Populated by buildAgentGroupImage. When unset, runtime falls back to
   * CONTAINER_IMAGE (i.e., the shared base nanoclaw-agent:latest).
   */
  imageTag?: string | null;
  /**
   * Phase 5C: agent-installable MCP servers. Read at agent-runner startup;
   * merged with plugin-provided MCP fragments.
   */
  mcpServers?: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}
```

- [ ] **Step 2: Test that empty + old-shape parse cleanly**

```ts
// src/__tests__/container-config-shape.test.ts
import { describe, it, expect } from 'vitest';
import type { ContainerConfig } from '../types.js';

describe('ContainerConfig parser', () => {
  it('parses an empty object as defaults', () => {
    const c: ContainerConfig = JSON.parse('{}');
    expect(c.packages).toBeUndefined();
    expect(c.imageTag).toBeUndefined();
    expect(c.dockerfilePartials).toBeUndefined();
  });

  it('parses an old-shape (Phase 4) row without new fields', () => {
    const json = '{"additionalMounts":[{"hostPath":"~/data","readonly":true}],"timeout":600000}';
    const c: ContainerConfig = JSON.parse(json);
    expect(c.timeout).toBe(600000);
    expect(c.packages).toBeUndefined();
  });

  it('parses a Phase 5 row with new fields', () => {
    const json = '{"packages":{"apt":["curl"],"npm":[]},"imageTag":"nanoclaw-agent:abc"}';
    const c: ContainerConfig = JSON.parse(json);
    expect(c.packages?.apt).toEqual(['curl']);
    expect(c.imageTag).toBe('nanoclaw-agent:abc');
  });
});
```

- [ ] **Step 3: Run tests**

```
cd /data/nanotars && pnpm typecheck && pnpm test src/__tests__/container-config-shape
```

- [ ] **Step 4: Commit**

```
cd /data/nanotars && git add src/types.ts src/__tests__/container-config-shape.test.ts
cd /data/nanotars && git commit -m "feat(5b): extend ContainerConfig with packages, dockerfilePartials, imageTag, mcpServers"
```

## 5B-02: generateAgentGroupDockerfile (pure)

**Reviewer dispatch:** YES — Dockerfile generation surface.

**Files:**
- New: `/data/nanotars/src/image-build.ts`
- New: `/data/nanotars/src/__tests__/image-build.test.ts`

- [ ] **Step 1: Write the function**

```ts
// src/image-build.ts
import fs from 'fs';
import path from 'path';

/**
 * Generate a Dockerfile that layers per-agent-group apt/npm packages and
 * project-relative Dockerfile.partials on top of an existing base image.
 *
 * Stacks on `nanoclaw-agent:latest` (base; already has plugin partials from
 * container/build.sh). Per-group additions go on top — agent-installable
 * apt/npm + host-managed dockerfilePartials.
 *
 * Pure: no IO, no container calls. Caller writes the output and runs the build.
 *
 * Mirrors v2's generateAgentGroupDockerfile (src/container-runner.ts:569-607)
 * with one divergence: v1 base is always nanoclaw-agent:latest, NOT node:22-slim.
 */
export function generateAgentGroupDockerfile(args: {
  baseImage: string;
  apt: string[];
  npm: string[];
  partials: string[];
  projectRoot: string;
}): string {
  const { baseImage, apt, npm, partials, projectRoot } = args;

  let out = `FROM ${baseImage}\nUSER root\n`;

  if (apt.length > 0) {
    out += `RUN apt-get update && apt-get install -y ${apt.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npm.length > 0) {
    out += `RUN npm install -g ${npm.join(' ')}\n`;
  }

  for (const partial of partials) {
    const resolved = path.resolve(projectRoot, partial);
    const rel = path.relative(projectRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`dockerfilePartial escapes project root: ${partial}`);
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`dockerfilePartial not found or not a file: ${partial}`);
    }
    const body = fs.readFileSync(resolved, 'utf8').trimEnd();
    out += `# --- partial: ${rel} ---\n${body}\n`;
  }

  out += 'USER node\n';
  return out;
}
```

- [ ] **Step 2: Tests**

```ts
// src/__tests__/image-build.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateAgentGroupDockerfile } from '../image-build.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanotars-5b-'));
});

describe('generateAgentGroupDockerfile', () => {
  it('emits FROM + USER root + USER node with no packages', () => {
    const out = generateAgentGroupDockerfile({
      baseImage: 'nanoclaw-agent:latest',
      apt: [], npm: [], partials: [], projectRoot: tmp,
    });
    expect(out).toContain('FROM nanoclaw-agent:latest');
    expect(out).toContain('USER root');
    expect(out).toContain('USER node');
    expect(out).not.toContain('apt-get');
    expect(out).not.toContain('npm install');
  });

  it('emits apt + npm RUN lines', () => {
    const out = generateAgentGroupDockerfile({
      baseImage: 'nanoclaw-agent:latest',
      apt: ['curl', 'jq'], npm: ['typescript'], partials: [], projectRoot: tmp,
    });
    expect(out).toMatch(/apt-get install -y curl jq/);
    expect(out).toMatch(/npm install -g typescript/);
  });

  it('inlines partial body with provenance comment', () => {
    const partialPath = path.join(tmp, 'plugins', 'foo', 'Dockerfile.partial');
    fs.mkdirSync(path.dirname(partialPath), { recursive: true });
    fs.writeFileSync(partialPath, 'RUN echo hi\n');
    const out = generateAgentGroupDockerfile({
      baseImage: 'nanoclaw-agent:latest',
      apt: [], npm: [], partials: ['plugins/foo/Dockerfile.partial'], projectRoot: tmp,
    });
    expect(out).toContain('# --- partial: plugins/foo/Dockerfile.partial ---');
    expect(out).toContain('RUN echo hi');
  });

  it('rejects path traversal partials', () => {
    expect(() =>
      generateAgentGroupDockerfile({
        baseImage: 'nanoclaw-agent:latest',
        apt: [], npm: [], partials: ['../etc/passwd'], projectRoot: tmp,
      })
    ).toThrow(/escapes project root/);
  });

  it('rejects missing partial files', () => {
    expect(() =>
      generateAgentGroupDockerfile({
        baseImage: 'nanoclaw-agent:latest',
        apt: [], npm: [], partials: ['plugins/foo/missing.partial'], projectRoot: tmp,
      })
    ).toThrow(/not found or not a file/);
  });
});
```

- [ ] **Step 3: Run tests**

```
cd /data/nanotars && pnpm typecheck && pnpm test src/__tests__/image-build
```

- [ ] **Step 4: Commit**

```
cd /data/nanotars && git add src/image-build.ts src/__tests__/image-build.test.ts
cd /data/nanotars && git commit -m "feat(5b): generateAgentGroupDockerfile (pure)"
```

## 5B-03: buildAgentGroupImage (does IO)

**Reviewer dispatch:** YES — Docker spawn surface.

**Files:**
- Modify: `/data/nanotars/src/container-runner.ts` — add `buildAgentGroupImage`.
- Modify: `/data/nanotars/src/db/agent-groups.ts` — add `updateAgentGroupContainerConfig` accessor.
- New: `/data/nanotars/src/__tests__/build-agent-group-image.test.ts`

- [ ] **Step 1: Add accessor for partial updates of `container_config`**

```ts
// src/db/agent-groups.ts
export function updateAgentGroupContainerConfig(
  id: string,
  mutator: (cfg: ContainerConfig) => ContainerConfig,
): void {
  const ag = getAgentGroupById(id);
  if (!ag) throw new Error(`agent group not found: ${id}`);
  const current: ContainerConfig = ag.container_config ? JSON.parse(ag.container_config) : {};
  const next = mutator(current);
  getDb().prepare(`UPDATE agent_groups SET container_config = ? WHERE id = ?`)
    .run(JSON.stringify(next), id);
}
```

- [ ] **Step 2: Add `buildAgentGroupImage`**

```ts
// src/container-runner.ts (append)
import { execSync } from 'child_process';
import { CONTAINER_IMAGE, DATA_DIR, INSTALL_SLUG } from './config.js';
import { getAgentGroupById, updateAgentGroupContainerConfig } from './db/agent-groups.js';
import { generateAgentGroupDockerfile } from './image-build.js';

export const CONTAINER_IMAGE_BASE = INSTALL_SLUG
  ? `nanoclaw-${INSTALL_SLUG}-agent`
  : 'nanoclaw-agent';

export async function buildAgentGroupImage(agentGroupId: string): Promise<string> {
  const ag = getAgentGroupById(agentGroupId);
  if (!ag) throw new Error(`Agent group not found: ${agentGroupId}`);

  const cfg: ContainerConfig = ag.container_config ? JSON.parse(ag.container_config) : {};
  const apt = cfg.packages?.apt ?? [];
  const npm = cfg.packages?.npm ?? [];
  const partials = cfg.dockerfilePartials ?? [];

  if (apt.length === 0 && npm.length === 0 && partials.length === 0) {
    throw new Error('Nothing to build. Add apt/npm packages via install_packages, or set dockerfilePartials.');
  }

  const dockerfile = generateAgentGroupDockerfile({
    baseImage: CONTAINER_IMAGE,         // 'nanoclaw-agent:latest' (or env override)
    apt, npm, partials,
    projectRoot: process.cwd(),
  });

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);

  logger.info({ agentGroupId, imageTag, apt, npm, partials }, 'Building per-agent-group image');
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    const cli = await containerRuntime.cli();
    execSync(
      `${cli} build -t ${imageTag} --label nanoclaw.agent_group=${agentGroupId} -f ${tmpDockerfile} .`,
      { cwd: process.cwd(), stdio: 'pipe', timeout: 300_000 },
    );
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  updateAgentGroupContainerConfig(agentGroupId, (c) => ({ ...c, imageTag }));
  logger.info({ agentGroupId, imageTag }, 'Per-agent-group image built');
  return imageTag;
}
```

- [ ] **Step 3: Tests**

```ts
// src/__tests__/build-agent-group-image.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase } from '../db/init.js';
import { createAgentGroup, getAgentGroupById, updateAgentGroupContainerConfig } from '../db/agent-groups.js';

vi.mock('child_process', () => ({ execSync: vi.fn() }));

describe('buildAgentGroupImage', () => {
  beforeEach(() => _initTestDatabase());

  it('throws when nothing to build', async () => {
    const ag = createAgentGroup({ name: 'x', folder: 'x', container_config: '{}' });
    const { buildAgentGroupImage } = await import('../container-runner.js');
    await expect(buildAgentGroupImage(ag.id)).rejects.toThrow(/Nothing to build/);
  });

  it('updates container_config.imageTag after build', async () => {
    const ag = createAgentGroup({
      name: 'x', folder: 'x',
      container_config: JSON.stringify({ packages: { apt: ['curl'], npm: [] } }),
    });
    const { buildAgentGroupImage } = await import('../container-runner.js');
    const tag = await buildAgentGroupImage(ag.id);
    expect(tag).toContain(`:${ag.id}`);
    const updated = getAgentGroupById(ag.id);
    expect(JSON.parse(updated!.container_config!).imageTag).toBe(tag);
  });
});
```

- [ ] **Step 4: Run**

```
cd /data/nanotars && pnpm typecheck && pnpm test src/__tests__/build-agent-group-image src/db/__tests__
```

- [ ] **Step 5: Commit**

```
cd /data/nanotars && git add src/container-runner.ts src/db/agent-groups.ts src/__tests__/build-agent-group-image.test.ts
cd /data/nanotars && git commit -m "feat(5b): buildAgentGroupImage + updateAgentGroupContainerConfig accessor"
```

## 5B-04: container-runner consumes imageTag with fallback

**Reviewer dispatch:** YES — runtime spawn path.

**Files:**
- Modify: `/data/nanotars/src/container-runner.ts` (line ~137 where `args.push(CONTAINER_IMAGE)`)
- New: `/data/nanotars/src/__tests__/spawn-image-tag.test.ts`

- [ ] **Step 1: Replace the hardcoded image push**

```ts
// inside buildContainerArgs or runContainerAgent, where args.push(CONTAINER_IMAGE) was:
const imageTag = containerConfig?.imageTag || CONTAINER_IMAGE;
args.push(imageTag);
```

- [ ] **Step 2: Test**

```ts
// src/__tests__/spawn-image-tag.test.ts
// Test that buildContainerArgs uses imageTag when present, CONTAINER_IMAGE otherwise.
// (Mock the underlying containerRuntime calls; assert the final args array.)
```

- [ ] **Step 3: Run + commit**

```
cd /data/nanotars && pnpm typecheck && pnpm test
cd /data/nanotars && git add src/container-runner.ts src/__tests__/spawn-image-tag.test.ts
cd /data/nanotars && git commit -m "feat(5b): container-runner uses container_config.imageTag with CONTAINER_IMAGE fallback"
```

## 5B-05: /rebuild-image admin slash command

**Reviewer dispatch:** NO — single-file admin-command extension.

**Files:**
- Modify: `/data/nanotars/src/command-gate.ts` (add `/rebuild-image` to ADMIN_COMMANDS)
- Modify: `/data/nanotars/src/orchestrator.ts` or `src/router.ts` (handle `/rebuild-image <agent-group-id>`)
- New: `/data/nanotars/src/__tests__/rebuild-image-command.test.ts`

- [ ] **Step 1: Add to ADMIN_COMMANDS**

```ts
// src/command-gate.ts
const ADMIN_COMMANDS = new Set<string>([
  // ... existing ...
  '/rebuild-image',
]);
```

- [ ] **Step 2: Wire handler**

In whichever file processes admin commands (find via `grep -n "isAdminCommand\|checkCommandPermission" src/`), add:

```ts
if (commandName === '/rebuild-image') {
  const targetId = parts[1];
  if (!targetId) return reply('Usage: /rebuild-image <agent-group-id>');
  try {
    const tag = await buildAgentGroupImage(targetId);
    return reply(`Image rebuilt: ${tag}`);
  } catch (err) {
    return reply(`Rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 3: Tests + commit**

```
cd /data/nanotars && pnpm typecheck && pnpm test
cd /data/nanotars && git add src/command-gate.ts src/orchestrator.ts src/__tests__/rebuild-image-command.test.ts
cd /data/nanotars && git commit -m "feat(5b): /rebuild-image admin command"
```

## 5B-06: 5B final review

**Reviewer dispatch:** YES — sub-phase boundary.

- [ ] Run full test suite + typecheck. Cross-tier reviewer dispatch.

---

# Sub-phase 5C — Self-modification

**Goal:** `install_packages` + `add_mcp_server` MCP tools land on the container side; host-side validation, approval queueing, approval handlers (which call 5B's `buildAgentGroupImage`) and container restart land on the host.

**Tasks:** 5C-00 (preflight) → 5C-01 (IPC types) → 5C-02 (MCP tools container-side) → 5C-03 (host validation + requestApproval bridge) → 5C-04 (approval handlers — applyInstallPackages, applyAddMcpServer) → 5C-05 (container restart helper) → 5C-06 (e2e integration test) → 5C-07 (final review).

## 5C-00: Preflight

```
cd /data/nanotars
git rev-parse HEAD
grep -n "registerApprovalHandler\|requestApproval" src/permissions/approval-primitive.ts
grep -n "buildAgentGroupImage" src/container-runner.ts   # confirm 5B exported it
grep -n "agent_groups\.container_config" src/db/agent-groups.ts   # confirm updateAgentGroupContainerConfig
```

## 5C-01: IPC type union extensions

**Reviewer dispatch:** YES — host↔container contract.

**Files:**
- Modify: `/data/nanotars/src/ipc/types.ts` — add `InstallPackagesTask`, `AddMcpServerTask` variants
- Modify: `/data/nanotars/src/ipc/types.ts` — add type guards
- New: `/data/nanotars/src/ipc/__tests__/types-self-mod.test.ts`

- [ ] **Step 1: Add to the discriminated union**

```ts
// src/ipc/types.ts
export interface InstallPackagesTask {
  type: 'install_packages';
  apt: string[];
  npm: string[];
  reason: string;
  groupFolder: string;
  isMain: boolean;
  timestamp: string;
}

export interface AddMcpServerTask {
  type: 'add_mcp_server';
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  groupFolder: string;
  isMain: boolean;
  timestamp: string;
}

export type IpcTask =
  | /* existing */
  | InstallPackagesTask
  | AddMcpServerTask;

export function isInstallPackagesTask(t: IpcTask): t is InstallPackagesTask {
  return t.type === 'install_packages';
}
export function isAddMcpServerTask(t: IpcTask): t is AddMcpServerTask {
  return t.type === 'add_mcp_server';
}
```

- [ ] **Step 2: Tests for type guards**

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add src/ipc/types.ts src/ipc/__tests__/types-self-mod.test.ts
cd /data/nanotars && git commit -m "feat(5c): IPC type union for install_packages + add_mcp_server"
```

## 5C-02: Container-side MCP tools

**Reviewer dispatch:** YES — agent-runner schema + new MCP-tool definitions.

**Files:**
- New: `/data/nanotars/container/agent-runner/src/mcp-tools/self-mod.ts`
- Modify: `/data/nanotars/container/agent-runner/src/ipc-mcp-stdio.ts` — register the new tools
- New: `/data/nanotars/container/agent-runner/src/mcp-tools/__tests__/self-mod.test.ts`

- [ ] **Step 1: Write self-mod.ts**

```ts
// container/agent-runner/src/mcp-tools/self-mod.ts
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

function writeIpcTask(data: object): string {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmp = path.join(TASKS_DIR, `${filename}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path.join(TASKS_DIR, filename));
  return filename;
}

export const installPackagesSchema = {
  apt: z.array(z.string()).optional().describe('apt package names (lowercase, no version specs)'),
  npm: z.array(z.string()).optional().describe('npm packages to install globally'),
  reason: z.string().describe('Why these packages are needed'),
};

export async function installPackagesHandler(args: {
  apt?: string[]; npm?: string[]; reason: string;
}, ctx: { groupFolder: string; isMain: boolean }) {
  const apt = args.apt || [];
  const npm = args.npm || [];
  if (apt.length === 0 && npm.length === 0) {
    return { content: [{ type: 'text' as const, text: 'Error: at least one apt or npm package required' }], isError: true };
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    return { content: [{ type: 'text' as const, text: `Error: max ${MAX_PACKAGES} packages` }], isError: true };
  }
  const badApt = apt.find((p) => !APT_RE.test(p));
  if (badApt) {
    return { content: [{ type: 'text' as const, text: `Error: invalid apt package "${badApt}"` }], isError: true };
  }
  const badNpm = npm.find((p) => !NPM_RE.test(p));
  if (badNpm) {
    return { content: [{ type: 'text' as const, text: `Error: invalid npm package "${badNpm}"` }], isError: true };
  }

  writeIpcTask({
    type: 'install_packages',
    apt, npm, reason: args.reason,
    groupFolder: ctx.groupFolder, isMain: ctx.isMain,
    timestamp: new Date().toISOString(),
  });
  return { content: [{ type: 'text' as const, text: 'Package install request submitted. You will be notified when admin approves or rejects.' }] };
}

export const addMcpServerSchema = {
  name: z.string().describe('MCP server name'),
  command: z.string().describe('Command to run the server'),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
};

export async function addMcpServerHandler(args: {
  name: string; command: string; args?: string[]; env?: Record<string, string>;
}, ctx: { groupFolder: string; isMain: boolean }) {
  if (!args.name || !args.command) {
    return { content: [{ type: 'text' as const, text: 'Error: name and command are required' }], isError: true };
  }
  writeIpcTask({
    type: 'add_mcp_server',
    name: args.name,
    command: args.command,
    args: args.args ?? [],
    env: args.env ?? {},
    groupFolder: ctx.groupFolder, isMain: ctx.isMain,
    timestamp: new Date().toISOString(),
  });
  return { content: [{ type: 'text' as const, text: 'MCP server request submitted. You will be notified when admin approves or rejects.' }] };
}
```

- [ ] **Step 2: Register in ipc-mcp-stdio.ts**

```ts
// container/agent-runner/src/ipc-mcp-stdio.ts
import {
  installPackagesSchema, installPackagesHandler,
  addMcpServerSchema, addMcpServerHandler,
} from './mcp-tools/self-mod.js';

server.tool(
  'install_packages',
  'Install apt and/or npm packages into YOUR per-agent container. Requires admin approval. Fire-and-forget.',
  installPackagesSchema,
  (args) => installPackagesHandler(args, { groupFolder, isMain }),
);

server.tool(
  'add_mcp_server',
  'Wire an EXISTING MCP server into YOUR runtime config. You must already know the exact command + args. Requires admin approval. Fire-and-forget.',
  addMcpServerSchema,
  (args) => addMcpServerHandler(args, { groupFolder, isMain }),
);
```

- [ ] **Step 3: Tests for the validation matrix**

```ts
// container/agent-runner/src/mcp-tools/__tests__/self-mod.test.ts
// Cover: empty list, > MAX, invalid apt name, invalid npm name, valid happy-path,
// add_mcp_server happy-path + missing-name + missing-command.
```

- [ ] **Step 4: Run + commit**

```
cd /data/nanotars/container/agent-runner && npm run typecheck && npm test
cd /data/nanotars && git add container/agent-runner/src/mcp-tools/self-mod.ts container/agent-runner/src/mcp-tools/__tests__/self-mod.test.ts container/agent-runner/src/ipc-mcp-stdio.ts
cd /data/nanotars && git commit -m "feat(5c): install_packages + add_mcp_server MCP tools"
```

## 5C-03: Host-side validation + requestApproval bridge

**Reviewer dispatch:** YES — security boundary; approval-handler registration.

**Files:**
- New: `/data/nanotars/src/permissions/install-packages.ts` (request flow)
- New: `/data/nanotars/src/permissions/add-mcp-server.ts` (request flow)
- Modify: `/data/nanotars/src/ipc/tasks.ts` — dispatch new task types to the handlers
- New: `/data/nanotars/src/permissions/__tests__/install-packages-request.test.ts`
- New: `/data/nanotars/src/permissions/__tests__/add-mcp-server-request.test.ts`

- [ ] **Step 1: Write install-packages.ts (request flow + handler registration stub for 5C-04)**

```ts
// src/permissions/install-packages.ts
import { requestApproval, registerApprovalHandler, notifyAgent } from './approval-primitive.js';
import { getAgentGroupByFolder } from '../db/agent-groups.js';
import { logger } from '../logger.js';

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

export async function handleInstallPackagesRequest(task: {
  apt: string[]; npm: string[]; reason: string; groupFolder: string;
}, originatingChannel: string): Promise<void> {
  const ag = getAgentGroupByFolder(task.groupFolder);
  if (!ag) {
    logger.warn({ folder: task.groupFolder }, 'install_packages: agent group not found');
    return;
  }

  if (task.apt.length + task.npm.length === 0) {
    notifyAgent(ag.id, 'install_packages failed: at least one package required.');
    return;
  }
  if (task.apt.length + task.npm.length > MAX_PACKAGES) {
    notifyAgent(ag.id, `install_packages failed: max ${MAX_PACKAGES} packages.`);
    return;
  }
  const badApt = task.apt.find((p) => !APT_RE.test(p));
  if (badApt) {
    notifyAgent(ag.id, `install_packages failed: invalid apt name "${badApt}".`);
    return;
  }
  const badNpm = task.npm.find((p) => !NPM_RE.test(p));
  if (badNpm) {
    notifyAgent(ag.id, `install_packages failed: invalid npm name "${badNpm}".`);
    return;
  }

  await requestApproval({
    action: 'install_packages',
    agentGroupId: ag.id,
    payload: { apt: task.apt, npm: task.npm, reason: task.reason },
    originatingChannel,
  });
}

// Handler registration moves here in 5C-04.
export function registerInstallPackagesHandler(): void {
  registerApprovalHandler('install_packages', {
    render({ payload }) {
      const apt = (payload.apt as string[] | undefined) ?? [];
      const npm = (payload.npm as string[] | undefined) ?? [];
      const reason = (payload.reason as string | undefined) ?? '';
      const list = [
        ...apt.map((p) => `apt: ${p}`),
        ...npm.map((p) => `npm: ${p}`),
      ].join(', ');
      return {
        title: 'Install Packages Request',
        body: `Agent wants to install + rebuild container:\n${list}${reason ? `\nReason: ${reason}` : ''}`,
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject',  label: 'Reject' },
        ],
      };
    },
    // applyDecision wired in 5C-04.
  });
}
```

- [ ] **Step 2: Write add-mcp-server.ts (mirror, plus command allowlist)**

```ts
// src/permissions/add-mcp-server.ts
import { requestApproval, registerApprovalHandler, notifyAgent } from './approval-primitive.js';
import { getAgentGroupByFolder } from '../db/agent-groups.js';

const ALLOWED_COMMAND_BASES = new Set(['npx', 'node', 'python', 'python3', 'bash']);
const ALLOWED_PATH_PREFIXES = ['/usr/local/bin/', '/workspace/'];

function isCommandAllowed(cmd: string): boolean {
  if (ALLOWED_COMMAND_BASES.has(cmd)) return true;
  return ALLOWED_PATH_PREFIXES.some((prefix) => cmd.startsWith(prefix));
}

export async function handleAddMcpServerRequest(task: {
  name: string; command: string; args: string[]; env: Record<string, string>; groupFolder: string;
}, originatingChannel: string): Promise<void> {
  const ag = getAgentGroupByFolder(task.groupFolder);
  if (!ag) return;

  if (!task.name || !task.command) {
    notifyAgent(ag.id, 'add_mcp_server failed: name and command required.');
    return;
  }
  if (!isCommandAllowed(task.command)) {
    notifyAgent(ag.id, `add_mcp_server failed: command not allowed. Common patterns: npx <pkg>, node <script>, /usr/local/bin/<binary>`);
    return;
  }

  await requestApproval({
    action: 'add_mcp_server',
    agentGroupId: ag.id,
    payload: { name: task.name, command: task.command, args: task.args, env: task.env },
    originatingChannel,
  });
}

export function registerAddMcpServerHandler(): void {
  registerApprovalHandler('add_mcp_server', {
    render({ payload }) {
      return {
        title: 'Add MCP Request',
        body: `Agent wants to add MCP server "${payload.name}" (${payload.command})`,
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject',  label: 'Reject' },
        ],
      };
    },
  });
}
```

- [ ] **Step 3: Wire in ipc/tasks.ts dispatcher**

```ts
// src/ipc/tasks.ts
case 'install_packages': {
  const { handleInstallPackagesRequest } = await import('../permissions/install-packages.js');
  return handleInstallPackagesRequest(task, /* originatingChannel */);
}
case 'add_mcp_server': {
  const { handleAddMcpServerRequest } = await import('../permissions/add-mcp-server.js');
  return handleAddMcpServerRequest(task, /* originatingChannel */);
}
```

- [ ] **Step 4: Wire registration in src/index.ts startup (alongside Phase 4C handlers)**

```ts
// src/index.ts (startup)
import { registerInstallPackagesHandler } from './permissions/install-packages.js';
import { registerAddMcpServerHandler } from './permissions/add-mcp-server.js';
registerInstallPackagesHandler();
registerAddMcpServerHandler();
```

- [ ] **Step 5: Tests**

Cover validation matrix per task variant; assert `requestApproval` called with the expected args; mock the primitive.

- [ ] **Step 6: Commit**

```
cd /data/nanotars && git add src/permissions/install-packages.ts src/permissions/add-mcp-server.ts src/ipc/tasks.ts src/index.ts src/permissions/__tests__/install-packages-request.test.ts src/permissions/__tests__/add-mcp-server-request.test.ts
cd /data/nanotars && git commit -m "feat(5c): host-side install_packages/add_mcp_server request validation + approval queueing"
```

## 5C-04: Approval-handler `applyDecision` (mutate config + rebuild + restart)

**Reviewer dispatch:** YES — image-build trigger from approval click.

**Files:**
- Modify: `/data/nanotars/src/permissions/install-packages.ts` (add `applyDecision`)
- Modify: `/data/nanotars/src/permissions/add-mcp-server.ts` (add `applyDecision`)
- Modify: `/data/nanotars/src/group-queue.ts` (add `restartGroup(groupFolder, reason)` helper that kills + sets pendingMessages=true)
- New: `/data/nanotars/src/permissions/__tests__/install-packages-apply.test.ts`
- New: `/data/nanotars/src/permissions/__tests__/add-mcp-server-apply.test.ts`

- [ ] **Step 1: Add `restartGroup` to GroupQueue**

```ts
// src/group-queue.ts
async restartGroup(groupFolder: string, reason: string): Promise<void> {
  for (const [jid, state] of this.groups) {
    if (state.groupFolder === groupFolder && state.process && !state.process.killed && state.containerName) {
      logger.info({ groupFolder, reason }, 'Restarting group container');
      await new Promise<void>((resolve) => {
        containerRuntime.stop(state.containerName!, () => {
          state.pendingMessages = true;   // ensure respawn on next inbound
          resolve();
        });
      });
      return;
    }
  }
  logger.debug({ groupFolder, reason }, 'restartGroup: no active container; pending state will spawn on next inbound');
}
```

- [ ] **Step 2: Wire `applyDecision` in install-packages.ts**

```ts
// src/permissions/install-packages.ts (extend the registration)
export function registerInstallPackagesHandler(deps: {
  buildImage: (id: string) => Promise<string>;
  restartGroup: (folder: string, reason: string) => Promise<void>;
  notifyAfter: (groupId: string, text: string, deferMs: number) => void;
}): void {
  registerApprovalHandler('install_packages', {
    render: /* same */,
    async applyDecision({ approvalId, payload, decision }) {
      if (decision !== 'approved') return;
      const apt = (payload.apt as string[]) ?? [];
      const npm = (payload.npm as string[]) ?? [];
      // Resolve agent group from approval row's agent_group_id (4C primitive stored it)
      // ... use getPendingApproval(approvalId) to read agent_group_id
      const approval = getPendingApproval(approvalId);
      const agentGroupId = approval?.agent_group_id as string;
      const ag = getAgentGroupById(agentGroupId);
      if (!ag) return;

      updateAgentGroupContainerConfig(agentGroupId, (cfg) => {
        const cur = cfg.packages ?? { apt: [], npm: [] };
        return { ...cfg, packages: { apt: [...cur.apt, ...apt], npm: [...cur.npm, ...npm] } };
      });

      try {
        await deps.buildImage(agentGroupId);
        await deps.restartGroup(ag.folder, 'install_packages applied');
        deps.notifyAfter(agentGroupId, `Packages installed (${[...apt.map((p)=>'apt:'+p), ...npm.map((p)=>'npm:'+p)].join(', ')}). Verify and report.`, 5000);
      } catch (err) {
        notifyAgent(agentGroupId, `Build failed: ${err instanceof Error ? err.message : String(err)}. An admin will need to retry.`);
      }
    },
  });
}
```

- [ ] **Step 3: Wire `applyDecision` in add-mcp-server.ts (no rebuild, restart only)**

```ts
async applyDecision({ approvalId, payload, decision }) {
  if (decision !== 'approved') return;
  const approval = getPendingApproval(approvalId);
  const agentGroupId = approval?.agent_group_id as string;
  const ag = getAgentGroupById(agentGroupId);
  if (!ag) return;
  updateAgentGroupContainerConfig(agentGroupId, (cfg) => ({
    ...cfg,
    mcpServers: { ...(cfg.mcpServers ?? {}), [payload.name as string]: {
      command: payload.command as string,
      args: (payload.args as string[]) ?? [],
      env: (payload.env as Record<string, string>) ?? {},
    } },
  }));
  await deps.restartGroup(ag.folder, 'add_mcp_server applied');
  notifyAgent(agentGroupId, `MCP server "${payload.name}" added. Container restarting.`);
}
```

- [ ] **Step 4: Wire startup**

In `src/index.ts`:

```ts
import { buildAgentGroupImage } from './container-runner.js';
registerInstallPackagesHandler({
  buildImage: buildAgentGroupImage,
  restartGroup: (folder, reason) => groupQueue.restartGroup(folder, reason),
  notifyAfter: (groupId, text, deferMs) => setTimeout(() => notifyAgent(groupId, text), deferMs),
});
registerAddMcpServerHandler({
  restartGroup: (folder, reason) => groupQueue.restartGroup(folder, reason),
});
```

- [ ] **Step 5: Tests**

End-to-end-ish:
- Pre-state: agent group with `container_config = '{}'`.
- Call `requestApproval({...install_packages...})` → assert pending row.
- Simulate `updateApprovalStatus('approved')` and dispatch via `applyDecision`.
- Assert `container_config.packages.apt` is now `['curl']`, `imageTag` is set, `restartGroup` was called.

- [ ] **Step 6: Commit**

```
cd /data/nanotars && git add src/permissions/install-packages.ts src/permissions/add-mcp-server.ts src/group-queue.ts src/index.ts src/permissions/__tests__/install-packages-apply.test.ts src/permissions/__tests__/add-mcp-server-apply.test.ts
cd /data/nanotars && git commit -m "feat(5c): applyDecision handlers — config mutate, image rebuild, container restart"
```

## 5C-05: notifyAgent wiring (replace stub with real injection)

**Reviewer dispatch:** YES — touches the path agents see.

**Files:**
- Modify: `/data/nanotars/src/permissions/approval-primitive.ts` (`notifyAgent` no longer a stub)
- Likely Modify: `/data/nanotars/src/orchestrator.ts` or `src/group-queue.ts` (system-message injection method)

- [ ] **Step 1: Replace the notifyAgent stub**

The Phase 4C primitive's `notifyAgent` is `logger.warn`-stub. Replace with: write a system message to the group's IPC inbox using v1's existing message-injection path. Find the v1 method (likely `dbEvents.emit('new-message', chatJid)` after writing a row, or a helper in orchestrator). The actual implementation is small: write a row in `messages` keyed to the agent's main chat_jid with `is_bot_message=1`, content prefixed appropriately, then emit the dbEvents trigger so the orchestrator picks it up.

```ts
// src/permissions/approval-primitive.ts
import { dbEvents } from '../db/init.js';
import { getAgentGroupById } from '../db/agent-groups.js';
// ... resolve mg from agent group's wirings (first wiring's mg.platform_id is the JID)

export function notifyAgent(agentGroupId: string | null, text: string): void {
  if (!agentGroupId) {
    logger.warn({ text }, 'notifyAgent: no agent group id provided');
    return;
  }
  const ag = getAgentGroupById(agentGroupId);
  if (!ag) return;
  // Find a wiring to derive the chat_jid (first by created_at)
  const wirings = getWiringForAgentGroup(agentGroupId);
  if (wirings.length === 0) {
    logger.warn({ agentGroupId }, 'notifyAgent: no wirings found; agent will not see notification');
    return;
  }
  const mg = getMessagingGroupById(wirings[0].messaging_group_id);
  if (!mg) return;

  const chatJid = mg.platform_id;
  const messageId = `system-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  insertMessage({
    id: messageId,
    chat_jid: chatJid,
    sender: 'system',
    sender_name: 'system',
    content: `[system] ${text}`,
    timestamp: new Date().toISOString(),
    is_from_me: 0,
    is_bot_message: 0,
  });
  dbEvents.emit('new-message', chatJid);
}
```

- [ ] **Step 2: Tests**

Verify the message lands in `messages` table and `dbEvents` fires.

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add src/permissions/approval-primitive.ts src/permissions/__tests__/approval-primitive.test.ts
cd /data/nanotars && git commit -m "feat(5c): notifyAgent injects a system message and wakes the orchestrator"
```

## 5C-06: End-to-end self-mod integration test

**Reviewer dispatch:** NO — test-only, but reviewer optional.

**Files:**
- New: `/data/nanotars/src/__tests__/self-mod-flow.test.ts`

- [ ] **Step 1: Write integration test**

Steps the test exercises:
1. Init in-memory DB; create an agent group + admin user role.
2. Mock `containerRuntime` (no actual docker calls); mock `execSync` for the build step.
3. Simulate a `install_packages` IPC task arriving at `handleInstallPackagesRequest`.
4. Assert one `pending_approvals` row created with correct payload.
5. Simulate the click flow: `updateApprovalStatus(approvalId, 'approved')` then dispatch via the approval-handler registry.
6. Assert `container_config.packages.apt` mutated, `buildAgentGroupImage` called, `restartGroup` called.
7. Re-run with `decision = 'rejected'` — config unchanged.
8. Negative case: invalid apt name → no approval row, notifyAgent called with error text.

- [ ] **Step 2: Run + commit**

```
cd /data/nanotars && pnpm test src/__tests__/self-mod-flow
cd /data/nanotars && git add src/__tests__/self-mod-flow.test.ts
cd /data/nanotars && git commit -m "test(5c): end-to-end install_packages approval flow"
```

## 5C-07: 5C final review

**Reviewer dispatch:** YES — sub-phase boundary. Reviewer focus: command-allowlist correctness, validation parity host vs container, approval-handler idempotency, race between `restartGroup` and a concurrent inbound message.

---

# Sub-phase 5D — Lifecycle pause/resume

**Goal:** `pausedGate` module + `emergency_stop` / `resume_processing` MCP tools + admin slash commands. EXTENDS v1's existing `emergencyStop`; doesn't replace.

**Tasks:** 5D-00 (preflight) → 5D-01 (pausedGate module) → 5D-02 (GroupQueue paused-gate) → 5D-03 (MCP tools + IPC types) → 5D-04 (host handlers) → 5D-05 (/pause + /resume admin commands) → 5D-06 (final review).

## 5D-00: Preflight

```
cd /data/nanotars
git rev-parse HEAD
grep -n "emergencyStop\|resumeProcessing" src/group-queue.ts src/orchestrator.ts
grep -rn "let paused\|isPaused\|pausedGate" src/ container/agent-runner/src/   # confirm namespace free
```

## 5D-01: pausedGate module

**Reviewer dispatch:** NO — single-file, simple state.

**Files:**
- New: `/data/nanotars/src/lifecycle.ts`
- New: `/data/nanotars/src/__tests__/lifecycle.test.ts`

- [ ] **Step 1: Write lifecycle.ts**

```ts
// src/lifecycle.ts
/**
 * Process-level pause gate. EXTENDS v1's existing GroupQueue.emergencyStop —
 * does not replace. While paused:
 *   - GroupQueue.runForGroup / enqueueMessageCheck no-op.
 *   - In-flight containers complete their current turn.
 *   - Inbound messages still ingest into the messages table; agents just
 *     don't wake until resume.
 *
 * Mirrors v2's modules/lifecycle/index.ts in shape, but layered on top of
 * v1's existing kill-on-emergency path rather than replacing it.
 *
 * Not persisted across restarts (matches v2 + v1 emergencyStop behavior).
 */

import { logger } from './logger.js';

let paused = false;

export const pausedGate = {
  isPaused(): boolean { return paused; },
  pause(reason: string): void {
    if (paused) {
      logger.info({ reason }, 'pausedGate.pause: already paused');
      return;
    }
    paused = true;
    logger.warn({ reason }, 'pausedGate: paused — new container wakes blocked');
  },
  resume(reason: string): void {
    if (!paused) {
      logger.info({ reason }, 'pausedGate.resume: not paused');
      return;
    }
    paused = false;
    logger.warn({ reason }, 'pausedGate: resumed — container wakes re-enabled');
  },
};

/** @internal - tests only */
export function _resetPausedGate(): void { paused = false; }
```

- [ ] **Step 2: Tests**

```ts
// src/__tests__/lifecycle.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { pausedGate, _resetPausedGate } from '../lifecycle.js';

describe('pausedGate', () => {
  beforeEach(_resetPausedGate);

  it('starts unpaused', () => expect(pausedGate.isPaused()).toBe(false));
  it('pause sets the flag', () => { pausedGate.pause('test'); expect(pausedGate.isPaused()).toBe(true); });
  it('resume clears the flag', () => {
    pausedGate.pause('test'); pausedGate.resume('test');
    expect(pausedGate.isPaused()).toBe(false);
  });
  it('double-pause is a no-op', () => {
    pausedGate.pause('a'); pausedGate.pause('b');
    expect(pausedGate.isPaused()).toBe(true);
  });
  it('resume when not paused is a no-op', () => {
    pausedGate.resume('test');
    expect(pausedGate.isPaused()).toBe(false);
  });
});
```

- [ ] **Step 3: Commit**

```
cd /data/nanotars && pnpm test src/__tests__/lifecycle
cd /data/nanotars && git add src/lifecycle.ts src/__tests__/lifecycle.test.ts
cd /data/nanotars && git commit -m "feat(5d): pausedGate module"
```

## 5D-02: GroupQueue gates wakes on pausedGate

**Reviewer dispatch:** YES — runtime spawn path.

**Files:**
- Modify: `/data/nanotars/src/group-queue.ts` — add `pausedGate.isPaused()` check at top of `enqueueMessageCheck` and `runForGroup`
- Modify: `/data/nanotars/src/__tests__/group-queue.test.ts` (or create the file)

- [ ] **Step 1: Add the check**

```ts
// src/group-queue.ts top of enqueueMessageCheck (after shuttingDown check)
if (pausedGate.isPaused()) {
  state.pendingMessages = true;
  logger.debug({ groupJid }, 'pausedGate is set; message queued, no wake');
  return;
}
```

Same gate on `enqueueTask`.

- [ ] **Step 2: Test**

Spy `runForGroup`, set `pausedGate.pause('test')`, call `enqueueMessageCheck` — assert no spawn but `pendingMessages = true`. Then `pausedGate.resume('test')` and call `drainWaiting()` — assert spawn happens.

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add src/group-queue.ts src/__tests__/group-queue.test.ts
cd /data/nanotars && git commit -m "feat(5d): GroupQueue gates wakes on pausedGate"
```

## 5D-03: MCP tools + IPC types

**Reviewer dispatch:** YES — IPC contract.

**Files:**
- Modify: `/data/nanotars/src/ipc/types.ts` — add `EmergencyStopTask`, `ResumeProcessingTask`
- New: `/data/nanotars/container/agent-runner/src/mcp-tools/lifecycle.ts`
- Modify: `/data/nanotars/container/agent-runner/src/ipc-mcp-stdio.ts` — register the tools

Follow the same shape as 5C-01 + 5C-02.

- [ ] **Step 1: Add IPC variants**

```ts
export interface EmergencyStopTask {
  type: 'emergency_stop';
  reason?: string;
  groupFolder: string; isMain: boolean; timestamp: string;
}
export interface ResumeProcessingTask {
  type: 'resume_processing';
  reason?: string;
  groupFolder: string; isMain: boolean; timestamp: string;
}
```

- [ ] **Step 2: MCP tools**

```ts
// container/agent-runner/src/mcp-tools/lifecycle.ts
import { z } from 'zod';
// writeIpcTask helper (could be shared via a small util module)

export const emergencyStopSchema = { reason: z.string().optional() };
export const resumeProcessingSchema = { reason: z.string().optional() };

export async function emergencyStopHandler(args: { reason?: string }, ctx: { groupFolder: string; isMain: boolean }) {
  writeIpcTask({
    type: 'emergency_stop',
    reason: args.reason,
    groupFolder: ctx.groupFolder, isMain: ctx.isMain,
    timestamp: new Date().toISOString(),
  });
  return { content: [{ type: 'text' as const, text: 'Pause request submitted.' }] };
}
export async function resumeProcessingHandler(args: { reason?: string }, ctx: { groupFolder: string; isMain: boolean }) {
  writeIpcTask({
    type: 'resume_processing',
    reason: args.reason,
    groupFolder: ctx.groupFolder, isMain: ctx.isMain,
    timestamp: new Date().toISOString(),
  });
  return { content: [{ type: 'text' as const, text: 'Resume request submitted.' }] };
}
```

- [ ] **Step 3: Register in ipc-mcp-stdio.ts**

- [ ] **Step 4: Tests + commit**

```
cd /data/nanotars && git add src/ipc/types.ts container/agent-runner/src/mcp-tools/lifecycle.ts container/agent-runner/src/ipc-mcp-stdio.ts container/agent-runner/src/mcp-tools/__tests__/lifecycle.test.ts
cd /data/nanotars && git commit -m "feat(5d): emergency_stop + resume_processing MCP tools + IPC types"
```

## 5D-04: Host handlers (admin re-validation)

**Reviewer dispatch:** YES — security boundary.

**Files:**
- New: `/data/nanotars/src/lifecycle-handlers.ts`
- Modify: `/data/nanotars/src/ipc/tasks.ts` — dispatch
- New: `/data/nanotars/src/__tests__/lifecycle-handlers.test.ts`

- [ ] **Step 1: Handlers re-check admin**

```ts
// src/lifecycle-handlers.ts
import { isAdminOfAgentGroup, isOwner, isGlobalAdmin } from './permissions/user-roles.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { resolveSender } from './permissions/sender-resolver.js';
import { pausedGate } from './lifecycle.js';
import { notifyAgent } from './permissions/approval-primitive.js';
import { logger } from './logger.js';

export async function handleEmergencyStop(task: {
  reason?: string; groupFolder: string;
}, senderUserId: string | undefined): Promise<void> {
  const ag = getAgentGroupByFolder(task.groupFolder);
  if (!ag) return;
  const allowed = senderUserId
    && (isOwner(senderUserId) || isGlobalAdmin(senderUserId) || isAdminOfAgentGroup(senderUserId, ag.id));
  if (!allowed) {
    notifyAgent(ag.id, 'emergency_stop denied: sender is not an admin.');
    logger.warn({ senderUserId, agentGroupId: ag.id }, 'emergency_stop dropped: not admin');
    return;
  }
  pausedGate.pause(task.reason ?? `agent ${ag.name}`);
  // Optional: also call groupQueue.emergencyStop() for the kill-now path.
  // TODO(5D-04): wire if/when we want kill-on-pause.
  notifyAgent(ag.id, 'Host paused. Future inbound is queued.');
}

export async function handleResumeProcessing(task: {
  reason?: string; groupFolder: string;
}, senderUserId: string | undefined): Promise<void> {
  const ag = getAgentGroupByFolder(task.groupFolder);
  if (!ag) return;
  const allowed = senderUserId
    && (isOwner(senderUserId) || isGlobalAdmin(senderUserId) || isAdminOfAgentGroup(senderUserId, ag.id));
  if (!allowed) {
    notifyAgent(ag.id, 'resume_processing denied: sender is not an admin.');
    return;
  }
  pausedGate.resume(task.reason ?? `agent ${ag.name}`);
  notifyAgent(ag.id, 'Host resumed.');
}
```

- [ ] **Step 2: Wire dispatch**

```ts
// src/ipc/tasks.ts
case 'emergency_stop': {
  const { handleEmergencyStop } = await import('../lifecycle-handlers.js');
  return handleEmergencyStop(task, /* sender resolution */);
}
case 'resume_processing': { /* mirror */ }
```

- [ ] **Step 3: Tests + commit**

```
cd /data/nanotars && git add src/lifecycle-handlers.ts src/ipc/tasks.ts src/__tests__/lifecycle-handlers.test.ts
cd /data/nanotars && git commit -m "feat(5d): host handlers for emergency_stop/resume with admin re-validation"
```

## 5D-05: /pause + /resume admin slash commands

**Reviewer dispatch:** NO — single-file admin command extension.

- [ ] **Step 1: Add to `ADMIN_COMMANDS`**

```ts
// src/command-gate.ts
'/pause', '/resume',
```

- [ ] **Step 2: Wire handler in router/orchestrator**

```ts
if (commandName === '/pause') {
  pausedGate.pause(`admin: ${userHandle}`);
  return reply('Host paused.');
}
if (commandName === '/resume') {
  pausedGate.resume(`admin: ${userHandle}`);
  return reply('Host resumed.');
}
```

- [ ] **Step 3: Tests + commit**

```
cd /data/nanotars && git add src/command-gate.ts src/orchestrator.ts src/__tests__/pause-resume-commands.test.ts
cd /data/nanotars && git commit -m "feat(5d): /pause + /resume admin slash commands"
```

## 5D-06: 5D final review

**Reviewer dispatch:** YES — sub-phase boundary.

---

# Sub-phase 5E — `create_agent` MCP tool

**Goal:** Admin-gated agent provisioning. Container-side conditional registration (only when `NANOCLAW_IS_ADMIN=1`); host-side admin re-check + DB writes + filesystem scaffold.

**Tasks:** 5E-00 (preflight) → 5E-01 (IPC type + container MCP tool) → 5E-02 (host handler + initGroupFilesystem) → 5E-03 (host sets NANOCLAW_IS_ADMIN env) → 5E-04 (e2e test) → 5E-05 (final review).

## 5E-00: Preflight

```
cd /data/nanotars
git rev-parse HEAD
grep -n "addAgentGroupMember\|isAdminOfAgentGroup\|createAgentGroup" src/permissions/*.ts src/db/agent-groups.ts
ls groups/global/IDENTITY.md   # confirm fallback exists
```

## 5E-01: IPC type + container MCP tool

**Reviewer dispatch:** YES — IPC + agent-runner schema.

**Files:**
- Modify: `/data/nanotars/src/ipc/types.ts` — add `CreateAgentTask`
- New: `/data/nanotars/container/agent-runner/src/mcp-tools/create-agent.ts`
- Modify: `/data/nanotars/container/agent-runner/src/ipc-mcp-stdio.ts` — conditional registration

- [ ] **Step 1: IPC type**

```ts
export interface CreateAgentTask {
  type: 'create_agent';
  name: string;
  instructions?: string | null;
  folder?: string | null;
  groupFolder: string; isMain: boolean; timestamp: string;
}
```

- [ ] **Step 2: MCP tool**

```ts
// container/agent-runner/src/mcp-tools/create-agent.ts
import { z } from 'zod';

export const createAgentSchema = {
  name: z.string().min(1).max(64).describe('Display name for the new agent group'),
  instructions: z.string().optional().describe('Optional CLAUDE.md content for the new agent'),
  folder: z.string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'folder must be lowercase alphanumeric with hyphens/underscores')
    .max(64)
    .optional()
    .describe('Optional folder name; auto-generated from `name` if omitted'),
};

export async function createAgentHandler(args: {
  name: string; instructions?: string; folder?: string;
}, ctx: { groupFolder: string; isMain: boolean }) {
  writeIpcTask({
    type: 'create_agent',
    name: args.name,
    instructions: args.instructions ?? null,
    folder: args.folder ?? null,
    groupFolder: ctx.groupFolder, isMain: ctx.isMain,
    timestamp: new Date().toISOString(),
  });
  return { content: [{ type: 'text' as const, text: `Creating agent "${args.name}". You will be notified when it is ready.` }] };
}
```

- [ ] **Step 3: Conditional registration in ipc-mcp-stdio.ts**

```ts
const isAdmin = process.env.NANOCLAW_IS_ADMIN === '1';
if (isAdmin) {
  server.tool(
    'create_agent',
    'Create a long-lived peer agent group. Admin-only. Fire-and-forget.',
    createAgentSchema,
    (args) => createAgentHandler(args, { groupFolder, isMain }),
  );
}
```

- [ ] **Step 4: Tests + commit**

Test that `create_agent` is NOT registered when env var unset.

```
cd /data/nanotars && git add src/ipc/types.ts container/agent-runner/src/mcp-tools/create-agent.ts container/agent-runner/src/ipc-mcp-stdio.ts container/agent-runner/src/mcp-tools/__tests__/create-agent.test.ts
cd /data/nanotars && git commit -m "feat(5e): create_agent MCP tool (admin-conditional registration)"
```

## 5E-02: Host handler + initGroupFilesystem

**Reviewer dispatch:** YES — security boundary + filesystem write.

**Files:**
- New: `/data/nanotars/src/permissions/create-agent.ts` (handler)
- New: `/data/nanotars/src/group-init.ts` (filesystem scaffold)
- Modify: `/data/nanotars/src/ipc/tasks.ts` — dispatch
- New: `/data/nanotars/src/permissions/__tests__/create-agent.test.ts`
- New: `/data/nanotars/src/__tests__/group-init.test.ts`

- [ ] **Step 1: initGroupFilesystem**

```ts
// src/group-init.ts
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import type { AgentGroup } from './types.js';
import { logger } from './logger.js';

export function initGroupFilesystem(group: AgentGroup, opts: { instructions?: string }): void {
  const groupPath = path.join(GROUPS_DIR, group.folder);
  // Path-traversal guard
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    throw new Error(`group folder escapes groups dir: ${group.folder}`);
  }
  fs.mkdirSync(groupPath, { recursive: true });

  // CLAUDE.md (optional)
  if (opts.instructions) {
    fs.writeFileSync(path.join(groupPath, 'CLAUDE.md'), opts.instructions);
  }

  // Default IDENTITY.md from groups/global/IDENTITY.md (existing v1 fallback)
  const globalIdentity = path.join(GROUPS_DIR, 'global', 'IDENTITY.md');
  const groupIdentity = path.join(groupPath, 'IDENTITY.md');
  if (fs.existsSync(globalIdentity) && !fs.existsSync(groupIdentity)) {
    fs.copyFileSync(globalIdentity, groupIdentity);
  }

  logger.info({ folder: group.folder, groupId: group.id }, 'Initialized group filesystem');
}
```

- [ ] **Step 2: Handler**

```ts
// src/permissions/create-agent.ts
import path from 'path';
import { GROUPS_DIR } from '../config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import { addAgentGroupMember } from './agent-group-members.js';
import { isAdminOfAgentGroup, isOwner, isGlobalAdmin } from './user-roles.js';
import { initGroupFilesystem } from '../group-init.js';
import { notifyAgent } from './approval-primitive.js';
import { logger } from '../logger.js';

const FOLDER_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_MAX = 64;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export async function handleCreateAgent(task: {
  name: string; instructions?: string | null; folder?: string | null; groupFolder: string;
}, senderUserId: string | undefined): Promise<void> {
  const callerAg = getAgentGroupByFolder(task.groupFolder);
  if (!callerAg) {
    logger.warn({ folder: task.groupFolder }, 'create_agent: caller group not found');
    return;
  }
  const allowed = senderUserId
    && (isOwner(senderUserId) || isGlobalAdmin(senderUserId) || isAdminOfAgentGroup(senderUserId, callerAg.id));
  if (!allowed) {
    notifyAgent(callerAg.id, 'create_agent denied: sender is not an admin.');
    logger.warn({ senderUserId, callerAgentGroup: callerAg.id }, 'create_agent dropped: not admin');
    return;
  }

  if (!task.name || task.name.length > NAME_MAX) {
    notifyAgent(callerAg.id, `create_agent failed: invalid name (1-${NAME_MAX} chars).`);
    return;
  }

  // Folder selection: explicit > slugify(name); ensure unique with -2, -3...
  let folder = (task.folder ?? slugify(task.name)).slice(0, 64);
  if (!FOLDER_RE.test(folder)) {
    notifyAgent(callerAg.id, `create_agent failed: folder must match ${FOLDER_RE.source}`);
    return;
  }
  let suffix = 2;
  let final = folder;
  while (getAgentGroupByFolder(final)) {
    final = `${folder}-${suffix++}`;
    if (suffix > 100) {
      notifyAgent(callerAg.id, 'create_agent failed: folder collision after 100 attempts.');
      return;
    }
  }

  const newAg = createAgentGroup({ name: task.name, folder: final });
  try {
    initGroupFilesystem(newAg, { instructions: task.instructions ?? undefined });
  } catch (err) {
    notifyAgent(callerAg.id, `create_agent failed: ${err instanceof Error ? err.message : String(err)}`);
    // No transactional rollback here (v1 lacks); leave the agent_groups row.
    // Operator can manually delete it if needed.
    return;
  }
  addAgentGroupMember({ user_id: senderUserId!, agent_group_id: newAg.id, added_by: senderUserId! });

  notifyAgent(callerAg.id, `Agent "${task.name}" created (folder=${final}). Run /wire <messaging-group> ${final} to receive messages.`);
  logger.info({ newAgentGroup: newAg.id, folder: final, parent: callerAg.id }, 'agent group created via create_agent');
}
```

- [ ] **Step 3: Wire dispatch in tasks.ts**

- [ ] **Step 4: Tests**

Cover: non-admin denied, missing groups/global/IDENTITY.md fallback, folder collision, path-traversal attempt, happy path produces row + filesystem + member.

- [ ] **Step 5: Commit**

```
cd /data/nanotars && git add src/permissions/create-agent.ts src/group-init.ts src/ipc/tasks.ts src/permissions/__tests__/create-agent.test.ts src/__tests__/group-init.test.ts
cd /data/nanotars && git commit -m "feat(5e): create_agent host handler + initGroupFilesystem"
```

## 5E-03: Host sets NANOCLAW_IS_ADMIN env var

**Reviewer dispatch:** YES — admin gating depends on this.

**Files:**
- Modify: `/data/nanotars/src/container-runner.ts` (or wherever the env file is built — see `container-mounts.ts:319-379`)

- [ ] **Step 1: Add the env**

When spawning a container for an inbound message, resolve the sender's role and set `NANOCLAW_IS_ADMIN=1` in the env file (or `-e` arg) iff `isOwner || isGlobalAdmin || isAdminOfAgentGroup(senderUserId, agentGroupId)`.

```ts
// roughly, in container-runner.ts/buildContainerArgs or container-mounts.ts/buildVolumeMounts
const senderUserId = /* resolved earlier */;
const isAdmin = senderUserId
  && (isOwner(senderUserId) || isGlobalAdmin(senderUserId) || isAdminOfAgentGroup(senderUserId, group.id));
args.push('-e', `NANOCLAW_IS_ADMIN=${isAdmin ? '1' : '0'}`);
```

For scheduled tasks (no live sender): default to `0`. Admins triggering tasks via `/schedule` keep their admin status only at command time, not at run time. Documented limitation.

- [ ] **Step 2: Tests**

Smoke test that the env arg is present and reflects admin status.

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add src/container-runner.ts src/container-mounts.ts src/__tests__/container-admin-env.test.ts
cd /data/nanotars && git commit -m "feat(5e): host sets NANOCLAW_IS_ADMIN env per spawn"
```

## 5E-04: End-to-end create_agent integration test

**Reviewer dispatch:** NO — test-only.

- [ ] **Step 1: Test the full path**

Steps:
1. Init test DB; create caller agent group + admin user role + sender user.
2. Simulate `create_agent` IPC arriving with name='Researcher', instructions='You are a research assistant'.
3. Assert new row in `agent_groups` with `folder='researcher'`.
4. Assert `groups/researcher/CLAUDE.md` exists with the instructions content.
5. Assert `agent_group_members` has row keyed to the sender + new group.
6. Assert `notifyAgent` text mentions the folder + `/wire` hint.
7. Negative: same flow with non-admin sender → no rows, denial message.

- [ ] **Step 2: Commit**

```
cd /data/nanotars && git add src/__tests__/create-agent-flow.test.ts
cd /data/nanotars && git commit -m "test(5e): end-to-end create_agent flow"
```

## 5E-05: 5E final review

**Reviewer dispatch:** YES — sub-phase boundary.

---

## Phase 5 closing

- [ ] **Final test pass**

```
cd /data/nanotars && pnpm typecheck && pnpm test
cd /data/nanotars/container/agent-runner && npm run typecheck && npm test
```

- [ ] **Final cross-tier review for any unreviewed cluster commits**

- [ ] **Update memory note**

After landing, append to `/root/.claude/projects/-data-nanoclaw-v2/memory/nantotars-catchup-state.md`:
- Phase 5 done with N commits across 5A-5E.
- Any deviation from plan + reason.
- Open items deferred (provider implementations, cross-container messaging, etc.).

- [ ] **Manual smoke (recommended)**

On a live install:
1. Confirm a regular inbound + reply still works (5A no-regression).
2. Run `install_packages` from a non-admin agent → notify-back denial; from an admin agent → approval card delivered to admin DM; on Approve, image rebuilds, container restarts, agent gets follow-up notify.
3. `/pause` from admin chat → bot stops responding; new message queued; `/resume` → bot processes the queued message.
4. `create_agent name='Test'` from admin → new `groups/test/` directory created; `/wire <jid> test` works.

---

## Reviewer dispatch summary

| Sub-phase | Tasks needing reviewer dispatch |
|-----------|----------------------------------|
| 5A        | 5A-01, 5A-03, 5A-05, 5A-06, 5A-07, 5A-08 |
| 5B        | 5B-02, 5B-03, 5B-04, 5B-06 |
| 5C        | 5C-01, 5C-02, 5C-03, 5C-04, 5C-05, 5C-07 |
| 5D        | 5D-02, 5D-03, 5D-04, 5D-06 |
| 5E        | 5E-01, 5E-02, 5E-03, 5E-05 |

Tasks NOT in this list are single-file mechanical changes that can ship without explicit reviewer dispatch (per memory note).

## Risk + rollback recap

Spec section "Risks + rollback plan" lists per-sub-phase rollback. Implementer should re-read before each sub-phase's first commit.

## Self-review checklist (run before submitting any sub-phase)

- [ ] Every spec section has at least one plan task implementing it (verified at sub-phase boundary).
- [ ] No placeholders (`TODO without a referenced ticket`, `FIXME`, `<insert here>`) remain in final code.
- [ ] Type/method names consistent across tasks (verified by typecheck).
- [ ] DDL before accessor before MCP tool registration (no out-of-order writes — none in Phase 5 since no new DDL).
- [ ] Container Dockerfile changes reviewed (none in Phase 5; per-group Dockerfiles are generated at runtime).
- [ ] Tests planned for self-mod approval flow (5C-06 covers it; safety-critical).
- [ ] Reviewer dispatched for each task in the table above.
- [ ] Preflight task at the top of each sub-phase records actual landed state into the first code commit's body.
