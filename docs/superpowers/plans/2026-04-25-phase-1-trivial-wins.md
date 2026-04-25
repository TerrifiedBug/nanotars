# Phase 1: Trivial Wins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land all ~14 trivial-effort PORT/ADOPT items from Phase 1 of the upstream triage (`/data/nanotars/docs/upstream-triage-2026-04-25.md`) onto the `v1-archive` branch — security hardening ports, Channel-interface additions, database additions, build hygiene, and one skill port.

**Architecture:** Each item is independently shippable on top of nanotars's existing v1 architecture (per-group containers, plugin-loader, file-IPC). No cross-task dependencies — items can be implemented in any order within their group, and committed individually. Each task = one commit. Existing channel plugins (whatsapp, discord, telegram, slack) keep working unchanged; new Channel-interface methods are optional.

**Tech Stack:** Node 22, TypeScript 5.7, vitest 4, better-sqlite3 11, pino 9. Container side uses Bun-less Node + `@anthropic-ai/claude-agent-sdk`. Tests use vitest; container tests under `container/agent-runner/src/` use vitest too (v1 hasn't split to bun:test).

**Spec input:** `/data/nanotars/docs/upstream-triage-2026-04-25.md` Phase 1 sequencing section + per-area verdict matrices (Areas 1, 4, 5, 6 contribute items to this plan).

---

## CONTRIBUTE upstream PRs — out of scope for this plan

The following items are CONTRIBUTE-class — already exist in v1, no nanotars-side work to do. They are PRs to `qwibitai/nanoclaw` and form a parallel workstream tracked separately:

- `AUTH_ERROR_PATTERNS` + `isAuthError` (v1 `src/router.ts:7-21`)
- Container hardening flags (v1 `src/container-runtime.ts:155-177`)
- `MAX_CONCURRENT_CONTAINERS` host-wide cap (v1 `src/group-queue.ts`)
- ffmpeg thumbnail extraction for inbound video/GIF (v1 `plugins/channels/whatsapp/index.js`)
- Magic-bytes MIME detection (v1 `plugins/channels/whatsapp/index.js`)
- Mount allowlist tests (v1 `src/__tests__/mount-security.test.ts`)
- `task_run_logs` table + JOIN-recent-runs view (v1 `src/db/init.ts`)
- `context_mode` ('group' | 'isolated') on `scheduled_tasks` (v1 `src/db/init.ts:49`)
- Online backup hook (v1 `src/db/init.ts`)
- `isValidGroupFolder` defense-in-depth validator (v1 `src/db.ts` / `src/ipc.ts`)

These are tracked separately. Don't open them in this plan — they will be a follow-up "Phase 1 CONTRIBUTE bundle" plan if/when Danny chooses to upstream them.

---

## Items deferred from Phase 1

- **Per-channel `extractReplyContext` hook** — v1's WhatsApp plugin already parses Baileys `contextInfo` inline. Formalizing the pattern as a hook only pays off when multiple channels use it, which fits Phase 2 Cluster C (Channels & media UX) where Telegram pairing flow + typed-media routing also land.
- **`tini` as PID 1** — purely cosmetic switch from `docker run --init` to ENTRYPOINT-based tini. Deferred to Phase 2 Cluster D (runtime hygiene) bundled with `source-as-RO-bind-mount`.
- **`shellQuote` unit tests** — v1 has no `shellQuote` function (env passing uses `--env-file` quoting in `container-mounts.ts`). Triage row stands as a CONTRIBUTE-only artifact for v2; nothing to PORT to v1.

---

## Pre-flight verification

**Files:**
- Read-only checks; no edits

- [ ] **Step 1: Verify nanotars is on v1-archive with clean tree**

Run: `cd /data/nanotars && git status --short --branch`
Expected: `## v1-archive...origin/v1-archive` with **no other lines**. If working tree dirty, abort and report to user.

- [ ] **Step 2: Verify existing Phase 0 commits are present**

Run: `cd /data/nanotars && git log --oneline -3`
Expected: top three commits should be `d6d45f1`, `88f67d0`, `01b9c52` (the three triage commits).

- [ ] **Step 3: Verify existing tests pass**

Run: `cd /data/nanotars && pnpm install --frozen-lockfile 2>/dev/null || npm install`
Then: `cd /data/nanotars && npm test`
Expected: full suite passes. If any pre-existing test fails, abort and investigate before adding changes.

- [ ] **Step 4: Confirm baseline file SHAs (will help diagnose unexpected changes later)**

Run:
```bash
cd /data/nanotars && git log --oneline -1 src/mount-security.ts src/types.ts src/router.ts src/db/init.ts container/agent-runner/src/security-hooks.ts container/build.sh container/Dockerfile package.json
```
Record the SHA of each file's last-modifying commit. Used as a sanity check at the end.

---

## Group A — Security hardening ports

### Task A1: Mount allowlist colon-injection check (PORT, trivial)

**Triage row (Area 6):** `Mount allowlist ':' injection check | PORT v2 → v1 | trivial | high`. v2's `src/modules/mount-security/index.ts:215` rejects colons in container paths to defend against `-v repo:rw` Docker option injection. v1's `isValidContainerPath` in `src/mount-security.ts:196-213` does not.

**Files:**
- Modify: `/data/nanotars/src/mount-security.ts:196-213` (add colon check inside `isValidContainerPath`)
- Test: `/data/nanotars/src/__tests__/mount-security.test.ts` (add test cases for colon rejection)

- [ ] **Step 1: Write failing tests for colon rejection**

Add to `src/__tests__/mount-security.test.ts` inside an existing or new `describe('isValidContainerPath', ...)` block. If the test file already exercises `validateMount` directly, add a new top-level test block:

```ts
import { validateMount } from '../mount-security.js';

describe('container path colon injection', () => {
  beforeEach(() => {
    // Use whatever existing setup creates a valid allowlist with a benign root
    // (mirror existing tests in this file)
  });

  it('rejects container paths containing colons', () => {
    const result = validateMount(
      { hostPath: '/tmp/some-allowed-root/file', containerPath: 'foo:rw' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Invalid container path/);
  });

  it('rejects container paths that look like Docker -v injections', () => {
    const result = validateMount(
      { hostPath: '/tmp/some-allowed-root/file', containerPath: 'workspace:/etc/passwd:ro' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Invalid container path/);
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `cd /data/nanotars && npx vitest run src/__tests__/mount-security.test.ts -t "colon"`
Expected: 2 FAIL — current `isValidContainerPath` allows colons.

- [ ] **Step 3: Add colon check to `isValidContainerPath`**

Edit `src/mount-security.ts` `isValidContainerPath` function (line 196). Add the colon check after the empty check, before the final `return true`:

```ts
function isValidContainerPath(containerPath: string): boolean {
  // Must not contain .. to prevent path traversal
  if (containerPath.includes('..')) {
    return false;
  }

  // Must not be absolute (it will be prefixed with /workspace/extra/)
  if (containerPath.startsWith('/')) {
    return false;
  }

  // Must not be empty
  if (!containerPath || containerPath.trim() === '') {
    return false;
  }

  // Must not contain colons — prevents Docker -v option injection (e.g., "repo:rw")
  if (containerPath.includes(':')) {
    return false;
  }

  return true;
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd /data/nanotars && npx vitest run src/__tests__/mount-security.test.ts`
Expected: full mount-security test file passes (existing + new colon tests).

- [ ] **Step 5: Run full test suite to confirm no regression**

Run: `cd /data/nanotars && npm test`
Expected: full suite passes.

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add src/mount-security.ts src/__tests__/mount-security.test.ts && git commit -m "$(cat <<'EOF'
fix(security): reject colon in container paths

Closes a Docker -v option-injection class: a container path of
"repo:rw" or "workspace:/etc/passwd:ro" would be passed through to
docker -v and re-interpreted as a separate bind-mount specification.
isValidContainerPath now rejects any container path containing a colon.

Ported from upstream nanoclaw v2 src/modules/mount-security/index.ts:215.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 6 PORT)
EOF
)"
```

### Task A2: dockerfilePartials path-traversal guard (PORT, trivial)

**Triage row (Area 5):** `dockerfilePartials path-traversal guard | PORT | trivial | high`. v2's `src/container-runner.ts:592-603` validates that each plugin Dockerfile partial resolves under the project root before reading it. v1's `container/build.sh` reads partials by glob (`plugins/*/Dockerfile.partial plugins/*/*/Dockerfile.partial`) without any guard — a malicious plugin could ship a symlinked partial pointing at `/etc/passwd` or escape via `..`.

The cleanest place for the v1 port is **in `container/build.sh`** (where partials are scanned), using bash-level path resolution rather than reimplementing the v2 TS function.

**Files:**
- Modify: `/data/nanotars/container/build.sh:25-29` (the partial-collection loop)
- Test: `/data/nanotars/container/__tests__/build-partials.test.sh` (new — bash test)

- [ ] **Step 1: Verify current partial-collection behavior**

Run:
```bash
cd /tmp && rm -rf build-partial-traversal-test && mkdir -p build-partial-traversal-test/plugins/evil
ln -sf /etc/passwd build-partial-traversal-test/plugins/evil/Dockerfile.partial
ls -la build-partial-traversal-test/plugins/evil/
```
Expected: symlink visible. The current `container/build.sh` glob loop would happily `cat` `/etc/passwd` into the combined Dockerfile.

(Don't run the actual build — just confirm the input shape that the guard must reject.)

- [ ] **Step 2: Write a failing bash test for the guard**

Create `/data/nanotars/container/__tests__/build-partials.test.sh`:

```bash
#!/bin/bash
# Test: build.sh's partial-collection rejects partials that resolve outside the project root.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Set up a tmp playground project with an evil symlinked partial
TMP="$(mktemp -d)"
trap "rm -rf $TMP" EXIT
mkdir -p "$TMP/plugins/evil"
ln -sf /etc/passwd "$TMP/plugins/evil/Dockerfile.partial"
mkdir -p "$TMP/container"
cp "$PROJECT_DIR/container/build.sh" "$TMP/container/build.sh"
cp "$PROJECT_DIR/container/Dockerfile" "$TMP/container/Dockerfile"

# Run build.sh from the playground in dry-run mode.
# (Use the runtime-detect failure case to short-circuit before actual docker build.)
cd "$TMP"
output="$(env PATH=/nonexistent bash container/build.sh 2>&1 || true)"

# We expect either: (a) the build.sh refuses the evil partial with an error, or
# (b) the build.sh exits before processing because no runtime is available — but
# the partial-collection step has run and emitted an error first.
if echo "$output" | grep -qi "escapes project root\|outside project\|invalid partial path"; then
  echo "PASS: build.sh rejected the path-escaping partial"
  exit 0
else
  echo "FAIL: build.sh accepted a partial that resolves to /etc/passwd"
  echo "Output: $output"
  exit 1
fi
```

Make it executable:
```bash
chmod +x /data/nanotars/container/__tests__/build-partials.test.sh
```

- [ ] **Step 3: Run test to confirm failure**

Run: `bash /data/nanotars/container/__tests__/build-partials.test.sh`
Expected: FAIL — current build.sh has no guard.

- [ ] **Step 4: Add the guard to build.sh**

Edit `/data/nanotars/container/build.sh`. Replace lines 25-29 (the `# Collect plugin Dockerfile.partial files` block):

```bash
# Collect plugin Dockerfile.partial files (validate each path resolves inside PROJECT_DIR)
PARTIALS=()
for f in plugins/*/Dockerfile.partial plugins/*/*/Dockerfile.partial; do
  [ -f "$f" ] || continue
  # Resolve the real path (follows symlinks) and ensure it stays under PROJECT_DIR.
  REAL="$(readlink -f "$f")"
  case "$REAL" in
    "$PROJECT_DIR"/*) PARTIALS+=("$f") ;;
    *) echo "Error: Dockerfile.partial '$f' escapes project root (resolves to '$REAL')"; exit 1 ;;
  esac
done
```

- [ ] **Step 5: Run test to confirm pass**

Run: `bash /data/nanotars/container/__tests__/build-partials.test.sh`
Expected: PASS — build.sh now exits with the "escapes project root" error.

- [ ] **Step 6: Run any existing build.sh smoke test (if present), then commit**

Run: `cd /data/nanotars && ls container/__tests__/ 2>/dev/null && find container -name "*.test.sh" -exec bash {} \;` to run any existing bash tests in the container tree.
Expected: existing tests (if any) still pass.

```bash
cd /data/nanotars && git add container/build.sh container/__tests__/build-partials.test.sh && git commit -m "$(cat <<'EOF'
fix(security): reject Dockerfile.partial paths that escape project root

A plugin's Dockerfile.partial is concatenated verbatim into the
combined Dockerfile during build. If a partial is a symlink pointing
outside PROJECT_DIR (e.g., /etc/passwd), its contents would land in
the image build context. Now build.sh resolves each candidate via
readlink -f and rejects any partial whose real path escapes
PROJECT_DIR.

Ported from upstream nanoclaw v2 src/container-runner.ts:592-603,
adapted to bash (v1's plugin partials are merged at build-time, not
at per-agent-group image build).

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 5 PORT)
EOF
)"
```

### Task A3: Bash security hooks `READ_TOOLS_RE` expansion (PORT, trivial)

**Triage row (Area 6):** `Bash security hooks READ_TOOLS_RE expansion | PORT v2 → v1 | trivial | high | Phase 1 | Adds more|od|hexdump|bun|awk|sed|python3 to v1's existing list`. v1's `container/agent-runner/src/security-hooks.ts:62` lists 11 read-tool binaries; v2 lists 17. Missing tools (`more`, `od`, `hexdump`, `bun`, `awk`, `sed`, `python3`) can each read `/proc/*/environ` or `~/.claude/.credentials.json` and bypass the hook.

**Files:**
- Modify: `/data/nanotars/container/agent-runner/src/security-hooks.ts:62`
- Test: `/data/nanotars/container/agent-runner/src/security-hooks.test.ts` (extend existing tests)

- [ ] **Step 1: Write failing tests for newly-blocked tools**

Read `container/agent-runner/src/security-hooks.test.ts` to find the existing `'sensitive paths'` describe block (or similar). Add tests for each new tool. Sample structure (adjust to match the file's existing pattern):

```ts
const sensitiveCmds = [
  'more /proc/1/environ',
  'od -c ~/.claude/.credentials.json',
  'hexdump -C /proc/self/environ',
  'awk \'{print}\' /proc/1/environ',
  'sed -n 1p ~/.claude/.credentials.json',
  'python3 -c "open(\'/proc/1/environ\').read()"',
  'bun -e "console.log(require(\'fs\').readFileSync(\'/proc/1/environ\').toString())"',
];

describe.each(sensitiveCmds)('blocks %s', (cmd) => {
  it('returns deny', async () => {
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: cmd },
    });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.reason).toMatch(/sensitive paths/);
  });
});
```

(Match the existing test file's `runHook` invocation style — read the file first.)

- [ ] **Step 2: Run tests to confirm failure**

Run: `cd /data/nanotars/container/agent-runner && npx vitest run src/security-hooks.test.ts -t "blocks"`
Expected: 7 FAIL — new tools are not in the regex.

- [ ] **Step 3: Update `READ_TOOLS_RE`**

Edit `container/agent-runner/src/security-hooks.ts` line 62. Replace:

```ts
const readTools = /\b(?:cat|less|head|tail|base64|xxd|strings|python|node|perl|ruby)\b/;
```

with:

```ts
const readTools = /\b(?:cat|less|more|head|tail|base64|xxd|strings|od|hexdump|python|python3|node|bun|perl|ruby|awk|sed)\b/;
```

(Mirrors v2's `READ_TOOLS_RE` at `container/agent-runner/src/security-hooks.ts:28`.)

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd /data/nanotars/container/agent-runner && npx vitest run src/security-hooks.test.ts`
Expected: full security-hooks suite passes.

- [ ] **Step 5: Run full test suite (host + container) to confirm no regression**

Run: `cd /data/nanotars && npm test && cd container/agent-runner && npx vitest run`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add container/agent-runner/src/security-hooks.ts container/agent-runner/src/security-hooks.test.ts && git commit -m "$(cat <<'EOF'
fix(security): expand bash hook read-tools regex

v1 blocked 11 read-tools (cat, less, head, tail, base64, xxd, strings,
python, node, perl, ruby) when targeting /proc/*/environ or
.credentials.json. v2 expanded to 17. The missing tools (more, od,
hexdump, bun, awk, sed, python3) can each read those paths and bypass
the security hook.

Ported from upstream nanoclaw v2 container/agent-runner/src/security-hooks.ts:28.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 6 PORT)
EOF
)"
```

---

## Group B — Channel interface additions

### Task B1: `splitForLimit` long-message splitter (ADOPT, trivial)

**Triage row (Area 4):** `splitForLimit long-message splitter | ADOPT | trivial | high | Phase 1 | Add to v1's channel base helpers`. v2's `chat-sdk-bridge.ts:104-118` has a 12-line pure function that splits a long string at the nearest newline before a configurable limit, used to send a multi-part message rather than a hard-cut. v1 channels currently hard-cut at platform limits.

**Files:**
- Create: `/data/nanotars/src/channel-helpers.ts` (new file)
- Test: `/data/nanotars/src/__tests__/channel-helpers.test.ts` (new file)

- [ ] **Step 1: Write failing tests for `splitForLimit`**

Create `src/__tests__/channel-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { splitForLimit } from '../channel-helpers.js';

describe('splitForLimit', () => {
  it('returns single chunk when text fits within limit', () => {
    expect(splitForLimit('hello', 100)).toEqual(['hello']);
  });

  it('splits at the last newline before the limit', () => {
    const text = 'line1\nline2\nline3\nline4';
    const out = splitForLimit(text, 12);
    expect(out).toEqual(['line1\nline2', 'line3\nline4']);
  });

  it('hard-splits when no newline is available within limit', () => {
    const text = 'aaaaaaaaaaaaaaaaaaaa'; // 20 a's, no newlines
    const out = splitForLimit(text, 7);
    expect(out).toEqual(['aaaaaaa', 'aaaaaaa', 'aaaaaa']);
  });

  it('returns [empty-string] for empty input rather than []', () => {
    expect(splitForLimit('', 100)).toEqual(['']);
  });

  it('handles a final tail shorter than limit', () => {
    const text = 'line1\nline2\nshort';
    const out = splitForLimit(text, 11);
    expect(out).toEqual(['line1\nline2', 'short']);
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `cd /data/nanotars && npx vitest run src/__tests__/channel-helpers.test.ts`
Expected: 5 FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement `splitForLimit`**

Create `src/channel-helpers.ts`:

```ts
/**
 * Split outbound text into chunks each ≤ `limit` characters.
 *
 * Prefers splitting at the last newline before the limit; falls back to a
 * hard-split when no newline is available. Returns `['']` for empty input
 * rather than `[]` so callers always have at least one chunk to send.
 *
 * Adopted from upstream nanoclaw v2 src/channels/chat-sdk-bridge.ts:104-118.
 */
export function splitForLimit(text: string, limit: number): string[] {
  if (text.length === 0) return [''];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const lastNewline = slice.lastIndexOf('\n');
    const splitAt = lastNewline > 0 ? lastNewline : limit;
    chunks.push(remaining.slice(0, splitAt));
    // Skip the newline character itself when split on a newline boundary
    remaining = remaining.slice(lastNewline > 0 ? splitAt + 1 : splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd /data/nanotars && npx vitest run src/__tests__/channel-helpers.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Run full test suite**

Run: `cd /data/nanotars && npm test`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add src/channel-helpers.ts src/__tests__/channel-helpers.test.ts && git commit -m "$(cat <<'EOF'
feat(channels): add splitForLimit helper for long outbound messages

12-line pure function that splits a long string at the nearest newline
before a configurable limit. Falls back to a hard-split when no
newline is available. Channel plugins can use this to send multi-part
messages rather than hard-cutting at platform limits.

Adopted from upstream nanoclaw v2 src/channels/chat-sdk-bridge.ts:104-118.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 4 ADOPT)
EOF
)"
```

### Task B2: `transformOutboundText` hook on `Channel` interface (ADOPT, trivial)

**Triage row (Area 4):** `Per-channel transformOutboundText hook | ADOPT | trivial | medium | Phase 1 | Hook on v1's Channel interface`. v2 lets each channel adapter declare a per-text transformation applied *before* delivery (e.g., Telegram-Markdown sanitization, WhatsApp emoji prefix). v1's router currently passes outbound text through unchanged after `redactSecrets`.

The hook is opt-in: existing channels keep working unchanged; channels that implement it get called.

**Files:**
- Modify: `/data/nanotars/src/types.ts:96-107` (Channel interface — add optional method)
- Modify: `/data/nanotars/src/router.ts` (`routeOutbound` — call hook before `sendMessage`)
- Test: `/data/nanotars/src/__tests__/router.test.ts` (or new test file)

- [ ] **Step 1: Write failing test**

Add to `src/__tests__/router.test.ts` (or, if router tests use a separate fake Channel, add a test for the new hook). Sample:

```ts
import { describe, it, expect, vi } from 'vitest';
import { routeOutbound } from '../router.js';
import type { Channel } from '../types.js';

function makeChannel(over: Partial<Channel> = {}): Channel {
  return {
    name: 'test',
    connect: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: vi.fn(),
    ...over,
  };
}

describe('routeOutbound transformOutboundText', () => {
  it('calls transformOutboundText if the channel implements it', async () => {
    const transform = vi.fn((s: string) => s.toUpperCase());
    const channel = makeChannel({ transformOutboundText: transform });

    // Use whatever fake PluginRegistry the file uses; or import a small helper.
    // The expected behavior: routeOutbound calls transformOutboundText then sendMessage.
    await routeOutbound(/* ... wire up minimal deps for routeOutbound, mirroring existing tests */);

    expect(transform).toHaveBeenCalledWith('hello');
    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'HELLO',
      undefined,
      undefined,
    );
  });

  it('skips the hook when channel does not implement it', async () => {
    const channel = makeChannel(); // no transformOutboundText
    await routeOutbound(/* ... same setup, with this channel */);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'hello',
      undefined,
      undefined,
    );
  });
});
```

(Adjust signatures to match the existing `routeOutbound` test pattern — the file probably wires a `PluginRegistry`-shaped object.)

- [ ] **Step 2: Run tests to confirm failure**

Run: `cd /data/nanotars && npx vitest run src/__tests__/router.test.ts -t "transformOutboundText"`
Expected: 2 FAIL — type error (`transformOutboundText` not on `Channel`) or runtime error (hook not called).

- [ ] **Step 3: Add `transformOutboundText` to the `Channel` interface**

Edit `src/types.ts:96-107`. Add the optional method after `sendMessage`:

```ts
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, sender?: string, replyTo?: string): Promise<void>;
  /**
   * Optional hook: transform outbound text immediately before delivery.
   *
   * Called after secret redaction and the `<internal>`-tag strip, but before
   * `sendMessage`. Useful for per-channel sanitization (e.g., escaping
   * Telegram-Markdown reserved characters, WhatsApp emoji prefixes).
   * If the channel does not implement this hook, the text is passed through
   * unchanged. Returning an empty string is allowed and suppresses delivery.
   */
  transformOutboundText?(text: string, jid: string): string | Promise<string>;
  sendFile?(jid: string, buffer: Buffer, mime: string, fileName: string, caption?: string): Promise<void>;
  react?(jid: string, messageId: string, emoji: string, participant?: string, fromMe?: boolean): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  refreshMetadata?(): Promise<void>;
  listAvailableGroups?(): Promise<Array<{ jid: string; name: string }>>;
}
```

- [ ] **Step 4: Wire the hook into `routeOutbound`**

Read `src/router.ts` to find `routeOutbound`. The function currently looks like:
```ts
const safeText = redactSecrets(stripInternalTags(text));
await channel.sendMessage(jid, safeText, sender, replyTo);
```

Insert the hook call between the redaction and `sendMessage`:

```ts
let safeText = redactSecrets(stripInternalTags(text));
if (channel.transformOutboundText) {
  safeText = await channel.transformOutboundText(safeText, jid);
}
if (safeText.length === 0) {
  // Hook returned empty — suppress delivery (channel-level rejection).
  logger.debug({ channel: channel.name, jid }, 'transformOutboundText returned empty; suppressing send');
  return;
}
await channel.sendMessage(jid, safeText, sender, replyTo);
```

(Use the file's existing `let`/`const` style and logger import. The exact line numbers depend on the current `routeOutbound` body.)

- [ ] **Step 5: Run tests to confirm pass**

Run: `cd /data/nanotars && npx vitest run src/__tests__/router.test.ts`
Expected: full router tests pass (existing + new transformOutboundText tests).

- [ ] **Step 6: Run typecheck and full test suite**

Run: `cd /data/nanotars && npm run typecheck && npm test`
Expected: typecheck clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /data/nanotars && git add src/types.ts src/router.ts src/__tests__/router.test.ts && git commit -m "$(cat <<'EOF'
feat(channels): add optional transformOutboundText hook on Channel

Channels can now declare a per-text transformation applied immediately
before sendMessage delivery. Useful for Telegram-Markdown sanitization,
WhatsApp emoji prefixes, etc. Hook is optional — existing channel
plugins (whatsapp, discord, telegram, slack) keep working unchanged.

routeOutbound calls the hook after secret redaction and internal-tag
strip; an empty return suppresses delivery (channel-level rejection).

Adopted from upstream nanoclaw v2 src/channels/adapter.ts hook surface.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 4 ADOPT)
EOF
)"
```

### Task B3: `openDM(userHandle)` channel primitive (ADOPT, trivial)

**Triage row (Area 4):** `openDM(userHandle) | ADOPT (was SKIP-ARCH) | small | high | Phase 1 | Add to v1's Channel interface; doesn't require user_dms`. v2's `ChannelAdapter.openDM` resolves a user handle (e.g., `@alice` on Slack, a Telegram username) to a JID/chat-id that subsequent `sendMessage` calls can target. v1 channels currently can only respond to JIDs they've already seen inbound traffic from.

This is a clean optional addition to v1's `Channel` interface. The primitive enables future "agent reaches out to a user proactively" flows; full multi-user `user_dms` cache lands in Phase 4.

**Files:**
- Modify: `/data/nanotars/src/types.ts:96-107` (Channel interface — add optional method)
- Test: `/data/nanotars/src/__tests__/types.test.ts` (or co-locate compile-only check in router test)

- [ ] **Step 1: Write a compile-time test (no runtime — interface addition)**

Since `openDM` is an interface addition, the meaningful "test" is that `tsc` compiles when a fake channel implements it. Add a test that constructs a fake Channel with `openDM` and verifies the type accepts it. Add to `src/__tests__/types.test.ts` (create if absent):

```ts
import { describe, it, expectTypeOf } from 'vitest';
import type { Channel } from '../types.js';

describe('Channel.openDM', () => {
  it('is an optional method that returns a JID', () => {
    const ch: Channel = {
      name: 'test',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
      openDM: async (handle: string) => `dm:${handle}@example`,
    };
    expectTypeOf(ch.openDM).toMatchTypeOf<((handle: string) => Promise<string | null>) | undefined>();
  });

  it('omitting openDM still satisfies Channel', () => {
    const ch: Channel = {
      name: 'test',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
    };
    expectTypeOf(ch.openDM).toMatchTypeOf<((handle: string) => Promise<string | null>) | undefined>();
  });
});
```

- [ ] **Step 2: Run typecheck to confirm failure**

Run: `cd /data/nanotars && npm run typecheck`
Expected: error — `openDM` is not on the Channel type.

- [ ] **Step 3: Add `openDM` to the `Channel` interface**

Edit `src/types.ts:96-107`. Add the optional method (after `transformOutboundText` from Task B2):

```ts
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, sender?: string, replyTo?: string): Promise<void>;
  transformOutboundText?(text: string, jid: string): string | Promise<string>;
  /**
   * Optional: resolve a user handle (e.g., '@alice', 'alice', 'tg:1234567')
   * to a chat JID that subsequent sendMessage calls can target.
   *
   * Returns null if the handle cannot be resolved (e.g., user does not exist,
   * channel does not support DM resolution from a handle, or privacy settings
   * prevent it). Channels that don't support cold-DM resolution should leave
   * this method undefined.
   */
  openDM?(handle: string): Promise<string | null>;
  sendFile?(jid: string, buffer: Buffer, mime: string, fileName: string, caption?: string): Promise<void>;
  react?(jid: string, messageId: string, emoji: string, participant?: string, fromMe?: boolean): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  refreshMetadata?(): Promise<void>;
  listAvailableGroups?(): Promise<Array<{ jid: string; name: string }>>;
}
```

- [ ] **Step 4: Run typecheck and tests to confirm pass**

Run: `cd /data/nanotars && npm run typecheck && npm test`
Expected: typecheck passes; all tests including the new types test pass.

- [ ] **Step 5: Commit**

```bash
cd /data/nanotars && git add src/types.ts src/__tests__/types.test.ts && git commit -m "$(cat <<'EOF'
feat(channels): add optional openDM(handle) primitive on Channel

Channels can now expose handle→JID resolution so the host can
proactively start a DM with a user the channel hasn't seen inbound
traffic from. Optional — existing channel plugins keep working
unchanged. Returns null when resolution fails (user unknown, privacy
settings, etc.).

Full multi-user user_dms cache + ensureUserDm two-class resolution
lands in Phase 4 of the catch-up; this is just the channel-side
primitive.

Adopted from upstream nanoclaw v2 src/channels/adapter.ts.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 4 ADOPT)
EOF
)"
```

### Task B4: `NetworkError` setup-retry wrapper (ADOPT, trivial)

**Triage row (Area 4):** `NetworkError setup retry | ADOPT | trivial | high | Phase 1 | 50-line retry wrapper with [2,5,10]s backoff`. v2's `src/channels/channel-registry.ts:10-94` wraps `connect()` with three retry attempts and a 2/5/10-second backoff. v1's `plugin-loader.ts initChannel` calls `onChannel(...)` once and lets it throw — bumpy network at startup means the channel never connects until the host is restarted.

**Files:**
- Modify: `/data/nanotars/src/plugin-loader.ts` (around `initChannel` at line 204)
- Test: `/data/nanotars/src/__tests__/plugin-loader.test.ts` (extend existing tests)

- [ ] **Step 1: Write failing test for the retry wrapper**

Add to `src/__tests__/plugin-loader.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { withSetupRetry } from '../plugin-loader.js'; // export from plugin-loader

class NetworkError extends Error {
  constructor(msg: string) { super(msg); this.name = 'NetworkError'; }
}

describe('withSetupRetry', () => {
  it('returns immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const out = await withSetupRetry('test-plugin', fn, { delays: [0, 0, 0] });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on NetworkError up to delays.length times', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new NetworkError('flap 1'))
      .mockRejectedValueOnce(new NetworkError('flap 2'))
      .mockResolvedValue('ok');
    const out = await withSetupRetry('test-plugin', fn, { delays: [0, 0, 0] });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows non-NetworkError without retry', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('config bad'));
    await expect(withSetupRetry('test-plugin', fn, { delays: [0, 0, 0] }))
      .rejects.toThrow(/config bad/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries and rethrows the last NetworkError', async () => {
    const fn = vi.fn().mockRejectedValue(new NetworkError('still down'));
    await expect(withSetupRetry('test-plugin', fn, { delays: [0, 0, 0] }))
      .rejects.toThrow(/still down/);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd /data/nanotars && npx vitest run src/__tests__/plugin-loader.test.ts -t "withSetupRetry"`
Expected: 4 FAIL — function not exported.

- [ ] **Step 3: Implement `withSetupRetry` in `plugin-loader.ts`**

At the top of `src/plugin-loader.ts` (above `class PluginRegistry`), add:

```ts
export interface SetupRetryOptions {
  /** Delay (ms) between attempts. Length determines retry count. Default: [2000, 5000, 10000]. */
  delays?: number[];
}

/**
 * Wrap a setup-time operation (e.g., a channel's connect()) with NetworkError-only retry.
 *
 * Retries up to `delays.length` times with backoff [2s, 5s, 10s] by default.
 * Only NetworkError-named errors trigger retry — config errors and other
 * exceptions bubble out immediately. Used to ride out transient flap at
 * channel-registration time without taking the host down.
 *
 * Adopted from upstream nanoclaw v2 src/channels/channel-registry.ts:10-94.
 */
export async function withSetupRetry<T>(
  pluginName: string,
  fn: () => Promise<T>,
  options: SetupRetryOptions = {},
): Promise<T> {
  const delays = options.delays ?? [2000, 5000, 10000];
  let lastError: unknown;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isNet = err instanceof Error && err.name === 'NetworkError';
      if (!isNet) throw err;
      const delay = delays[attempt];
      logger.warn(
        { plugin: pluginName, attempt: attempt + 1, of: delays.length, delayMs: delay, error: (err as Error).message },
        'Plugin setup failed with NetworkError; retrying',
      );
      if (delay > 0) await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw lastError;
}
```

- [ ] **Step 4: Wire the wrapper into `initChannel`**

In `plugin-loader.ts initChannel` (around line 204), wrap the `onChannel` call:

```ts
async initChannel(plugin: LoadedPlugin, ctx: PluginContext, config: ChannelPluginConfig): Promise<Channel> {
  if (!plugin.hooks.onChannel) {
    throw new Error(`Plugin ${plugin.manifest.name} does not export onChannel`);
  }
  const channel = await withSetupRetry(plugin.manifest.name, () =>
    plugin.hooks.onChannel!(ctx, config),
  );
  // ... rest unchanged
  return channel;
}
```

- [ ] **Step 5: Run tests to confirm pass**

Run: `cd /data/nanotars && npx vitest run src/__tests__/plugin-loader.test.ts`
Expected: full plugin-loader tests pass (existing + new).

- [ ] **Step 6: Run full suite**

Run: `cd /data/nanotars && npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /data/nanotars && git add src/plugin-loader.ts src/__tests__/plugin-loader.test.ts && git commit -m "$(cat <<'EOF'
feat(plugin-loader): retry channel setup on transient NetworkError

withSetupRetry wraps the onChannel(ctx, config) call with [2s, 5s, 10s]
backoff for errors named 'NetworkError'. Configuration/auth errors
still bubble out immediately. Lets the host ride out transient network
flap at channel-registration time without restarting.

Adopted from upstream nanoclaw v2 src/channels/channel-registry.ts:10-94.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 4 ADOPT)
EOF
)"
```

---

## Group C — Database additions

### Task C1: Decoupling connection from schema refactor (PORT, trivial)

**Triage row (Area 1):** `Decoupling connection from schema (initDb does not run DDL) | PORT | trivial | high | Phase 1 | Pure refactor; lets test variants reuse the runner without re-running DDL`. v2 separates the DB connection (`getDb`/`initDb`) from schema creation so tests can open the DB without re-running DDL. v1 conflates them — `init.ts` calls `createSchema(db)` from inside `initDb`.

**Files:**
- Modify: `/data/nanotars/src/db/init.ts` (`initDb` and `createSchema` — make `createSchema` an explicit step)

- [ ] **Step 1: Read current `initDb` flow**

Read `src/db/init.ts`. Note where `createSchema(db)` is called from inside `initDb`. The refactor: `initDb` opens the connection only; callers (or `index.ts`) call `createSchema(db)` explicitly.

- [ ] **Step 2: Write failing test for `initDb` not running DDL**

Add to `src/db/__tests__/db.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../init.js'; // ensure createSchema is exported

describe('createSchema decoupled from initDb', () => {
  it('createSchema can run on a fresh connection without prior init', () => {
    const db = new Database(':memory:');
    expect(() => createSchema(db)).not.toThrow();
    // Verify a known table exists
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain('messages');
  });

  it('createSchema is idempotent (re-running is a no-op)', () => {
    const db = new Database(':memory:');
    createSchema(db);
    expect(() => createSchema(db)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to confirm failure**

Run: `cd /data/nanotars && npx vitest run src/db/__tests__/db.test.ts -t "createSchema decoupled"`
Expected: FAIL — `createSchema` is not exported (currently it's a private function inside `init.ts`).

- [ ] **Step 4: Export `createSchema` and remove the auto-call from `initDb`**

In `src/db/init.ts`:
- Change `function createSchema(database: Database.Database)` to `export function createSchema(database: Database.Database)`.
- In `initDb`, find where `createSchema(db)` is called and remove that line.
- In whatever caller invokes `initDb` (likely `src/index.ts`), add an explicit `createSchema(getDb())` call right after `initDb()`.

Run `grep -n "initDb\(\)\|initDb(" /data/nanotars/src/*.ts` to find the call site.

- [ ] **Step 5: Run tests to confirm pass**

Run: `cd /data/nanotars && npx vitest run src/db/__tests__/db.test.ts && npm test`
Expected: all pass — including the new decoupled test, plus all pre-existing tests.

- [ ] **Step 6: Smoke-test the host startup path**

Run: `cd /data/nanotars && timeout 10 npm run dev 2>&1 | head -30 || true`
Expected: host boots, log includes "Database initialized" or equivalent, no errors. (Doesn't matter if it errors out later on missing channels — we just need DB init to complete cleanly.)

- [ ] **Step 7: Commit**

```bash
cd /data/nanotars && git add src/db/init.ts src/index.ts src/db/__tests__/db.test.ts && git commit -m "$(cat <<'EOF'
refactor(db): decouple createSchema from initDb

initDb now opens the connection only; callers invoke createSchema
explicitly. Tests can construct an in-memory DB and run createSchema
without going through initDb's full lifecycle. Production startup
path (src/index.ts) gains an explicit createSchema(getDb()) call.

Ported from upstream nanoclaw v2 src/db/connection.ts (decoupled from
schema.ts).

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 1 PORT)
EOF
)"
```

### Task C2: `hasTable(db, name)` helper (PORT, trivial)

**Triage row (Area 1):** `hasTable(db, name) helper for module-table guards | PORT | trivial | high | Phase 1 | 5 LOC; needed if v1 grows optional plugin tables`. Helper used by future plugin-shipped migrations to detect their own tables before creating them.

**Files:**
- Modify: `/data/nanotars/src/db/init.ts` (add helper)
- Test: `/data/nanotars/src/db/__tests__/db.test.ts`

- [ ] **Step 1: Write failing test**

Add to `src/db/__tests__/db.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { hasTable, createSchema } from '../init.js';

describe('hasTable', () => {
  it('returns false for a missing table', () => {
    const db = new Database(':memory:');
    expect(hasTable(db, 'no_such_table')).toBe(false);
  });

  it('returns true for an existing table', () => {
    const db = new Database(':memory:');
    createSchema(db);
    expect(hasTable(db, 'messages')).toBe(true);
  });

  it('rejects table names that are not safe identifiers', () => {
    const db = new Database(':memory:');
    expect(() => hasTable(db, "messages'; DROP TABLE messages--")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd /data/nanotars && npx vitest run src/db/__tests__/db.test.ts -t "hasTable"`
Expected: 3 FAIL — `hasTable` not exported.

- [ ] **Step 3: Implement `hasTable`**

In `src/db/init.ts`, after `createSchema`:

```ts
/**
 * Check whether a table exists in the connected database.
 *
 * `name` must be a SQL-identifier-shaped string ([A-Za-z_][A-Za-z0-9_]*).
 * Throws on unsafe input — protects against accidental injection through
 * the parameterized `sqlite_master` lookup, which uses the value as a
 * literal string.
 *
 * Ported from upstream nanoclaw v2 src/db/schema.ts hasTable utility.
 */
export function hasTable(db: Database.Database, name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid table name: ${JSON.stringify(name)}`);
  }
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd /data/nanotars && npx vitest run src/db/__tests__/db.test.ts -t "hasTable"`
Expected: 3 PASS.

- [ ] **Step 5: Run full suite**

Run: `cd /data/nanotars && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add src/db/init.ts src/db/__tests__/db.test.ts && git commit -m "$(cat <<'EOF'
feat(db): add hasTable(db, name) helper

Lets future plugin-shipped migrations check for their own tables
before creating them. Validates the table name against a safe
identifier shape to prevent SQL injection through what would otherwise
be a literal-string lookup against sqlite_master.

Ported from upstream nanoclaw v2 src/db/schema.ts.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 1 PORT)
EOF
)"
```

### Task C3: `unregistered_senders` table + upsert-coalesce accessor (ADOPT, small)

**Triage row (Area 1):** `unregistered_senders table + upsert-coalesce accessor | ADOPT | small | high | Phase 1 | ~30 LOC; channel:platform key already maps to v1's chats.jid`. Diagnostic table — counts inbound messages from senders that don't match any registered group, useful for surfacing "this user keeps DMing the bot, do you want to register them?" cards in Phase 4.

**Files:**
- Modify: `/data/nanotars/src/db/init.ts` (add table to `createSchema`)
- Create: `/data/nanotars/src/db/unregistered-senders.ts` (new accessor module)
- Test: `/data/nanotars/src/db/__tests__/unregistered-senders.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/db/__tests__/unregistered-senders.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../init.js';
import { recordUnregisteredSender, listUnregisteredSenders, clearUnregisteredSender } from '../unregistered-senders.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createSchema(db);
});

describe('unregistered-senders accessor', () => {
  it('records the first sighting of a sender', () => {
    recordUnregisteredSender(db, 'whatsapp', '447777777777@s.whatsapp.net', 'Jane');
    const rows = listUnregisteredSenders(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'whatsapp', platform_id: '447777777777@s.whatsapp.net', sender_name: 'Jane', count: 1 });
  });

  it('coalesces repeated sightings (count++ + last_seen update)', () => {
    recordUnregisteredSender(db, 'whatsapp', '447777777777@s.whatsapp.net', 'Jane');
    recordUnregisteredSender(db, 'whatsapp', '447777777777@s.whatsapp.net', 'Jane');
    recordUnregisteredSender(db, 'whatsapp', '447777777777@s.whatsapp.net', 'Jane');
    const rows = listUnregisteredSenders(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
  });

  it('treats different (channel, platform_id) pairs as separate rows', () => {
    recordUnregisteredSender(db, 'whatsapp', 'a@s.whatsapp.net', 'A');
    recordUnregisteredSender(db, 'discord', 'a@s.whatsapp.net', 'A');
    recordUnregisteredSender(db, 'whatsapp', 'b@s.whatsapp.net', 'B');
    expect(listUnregisteredSenders(db)).toHaveLength(3);
  });

  it('clearUnregisteredSender removes the row', () => {
    recordUnregisteredSender(db, 'whatsapp', 'a@s.whatsapp.net', 'A');
    clearUnregisteredSender(db, 'whatsapp', 'a@s.whatsapp.net');
    expect(listUnregisteredSenders(db)).toHaveLength(0);
  });

  it('updates sender_name to the most-recent observed name', () => {
    recordUnregisteredSender(db, 'whatsapp', 'a@s.whatsapp.net', 'OldName');
    recordUnregisteredSender(db, 'whatsapp', 'a@s.whatsapp.net', 'NewName');
    const rows = listUnregisteredSenders(db);
    expect(rows[0].sender_name).toBe('NewName');
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `cd /data/nanotars && npx vitest run src/db/__tests__/unregistered-senders.test.ts`
Expected: 5 FAIL — table + module don't exist.

- [ ] **Step 3: Add table to `createSchema`**

In `src/db/init.ts createSchema`, append (after the `sessions` table):

```sql
CREATE TABLE IF NOT EXISTS unregistered_senders (
  channel TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (channel, platform_id)
);
CREATE INDEX IF NOT EXISTS idx_unregistered_last_seen ON unregistered_senders(last_seen);
```

- [ ] **Step 4: Implement the accessor module**

Create `src/db/unregistered-senders.ts`:

```ts
import type Database from 'better-sqlite3';

export interface UnregisteredSenderRow {
  channel: string;
  platform_id: string;
  sender_name: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

/**
 * Record (or coalesce) a sighting of an inbound sender that doesn't
 * match any registered group. Increments `count` and updates `last_seen`
 * + `sender_name` on conflict.
 *
 * Adopted from upstream nanoclaw v2 unregistered_senders accessor.
 */
export function recordUnregisteredSender(
  db: Database.Database,
  channel: string,
  platformId: string,
  senderName: string,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO unregistered_senders (channel, platform_id, sender_name, count, first_seen, last_seen)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(channel, platform_id) DO UPDATE SET
      count = count + 1,
      sender_name = excluded.sender_name,
      last_seen = excluded.last_seen
  `).run(channel, platformId, senderName, now, now);
}

export function listUnregisteredSenders(db: Database.Database): UnregisteredSenderRow[] {
  return db
    .prepare(`SELECT channel, platform_id, sender_name, count, first_seen, last_seen FROM unregistered_senders ORDER BY last_seen DESC`)
    .all() as UnregisteredSenderRow[];
}

export function clearUnregisteredSender(
  db: Database.Database,
  channel: string,
  platformId: string,
): void {
  db.prepare(`DELETE FROM unregistered_senders WHERE channel = ? AND platform_id = ?`).run(channel, platformId);
}
```

- [ ] **Step 5: Run tests to confirm pass**

Run: `cd /data/nanotars && npx vitest run src/db/__tests__/unregistered-senders.test.ts`
Expected: 5 PASS.

- [ ] **Step 6: Run full suite**

Run: `cd /data/nanotars && npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /data/nanotars && git add src/db/init.ts src/db/unregistered-senders.ts src/db/__tests__/unregistered-senders.test.ts && git commit -m "$(cat <<'EOF'
feat(db): add unregistered_senders table + coalesce accessor

Diagnostic table that counts inbound messages from senders not
matching any registered group. Useful for "this user keeps DMing
the bot — register them?" cards (full integration in Phase 4 D).
Composite PK (channel, platform_id) deduplicates sightings;
sender_name updates to the most recent observed name; count
increments on every sighting.

The router's "no group matches this sender" path is wired up in a
follow-up commit (it's a behavior change, not a schema addition).

Adopted from upstream nanoclaw v2 unregistered_senders module.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 1 ADOPT)
EOF
)"
```

---

## Group D — Build hygiene

### Task D1: Pinned CLI ARG versions in Dockerfile (ADOPT, trivial)

**Triage row (Area 3):** `Pinned CLI ARG versions in Dockerfile | ADOPT | trivial | high | Phase 1 | Good hygiene; v1 is unpinned`. v2's Dockerfile pins `CLAUDE_CODE_VERSION`, `AGENT_BROWSER_VERSION`, `TSX_VERSION` via `ARG`. v1's `container/Dockerfile` runs `npm install -g agent-browser @anthropic-ai/claude-code` (line 44) and `npm install -g tsx` (line 62) without pinning — supply-chain blast radius is "whatever's latest at build time."

**Files:**
- Modify: `/data/nanotars/container/Dockerfile`

- [ ] **Step 1: Find current pinned versions in upstream v2 for reference**

Run: `grep -E "^ARG (CLAUDE_CODE|AGENT_BROWSER|TSX)" /data/nanoclaw-v2/container/Dockerfile`
Expected: three ARG lines with exact versions. Record them — these are the recommended pin set.

- [ ] **Step 2: Identify v1's current version in `agent-browser` and `@anthropic-ai/claude-code`**

Run: `cd /data/nanotars && grep -A2 "agent-browser\|claude-code" container/agent-runner/package.json`
Record the versions there as a baseline. The Dockerfile's globally-installed versions can match those plus whatever upstream has pinned (or pin to whatever's currently published; just be explicit).

- [ ] **Step 3: Edit `container/Dockerfile` — add ARG lines and reference them in RUN steps**

Near the top of the Dockerfile (after `FROM node:22-slim`), add:

```dockerfile
ARG CLAUDE_CODE_VERSION=2.0.34
ARG AGENT_BROWSER_VERSION=0.4.2
ARG TSX_VERSION=4.19.2
```

(Use the actual versions from Step 1/2; the values above are placeholders.)

Then update the install lines:
- Line 44 currently: `RUN npm install -g agent-browser @anthropic-ai/claude-code`
  → `RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`
- Line 62 currently: `RUN npm install -g tsx`
  → `RUN npm install -g tsx@${TSX_VERSION}`

- [ ] **Step 4: Verify the Dockerfile parses and the build context is happy**

Run: `cd /data/nanotars && docker buildx build --check -f container/Dockerfile . 2>&1 | head -20` (or `docker build --dry-run` if `buildx` not available; the goal is just syntax validation, no actual build).
Expected: no errors.

- [ ] **Step 5: (Optional, if local Docker is available) Run a real build to verify the image still builds**

Run: `cd /data/nanotars && bash container/build.sh 2>&1 | tail -30`
Expected: image builds successfully, "Build complete" message at the end.

(If Docker is not available locally, skip this step and rely on Step 4.)

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add container/Dockerfile && git commit -m "$(cat <<'EOF'
build(container): pin CLI versions via ARG

Pins agent-browser, @anthropic-ai/claude-code, and tsx to specific
versions via Dockerfile ARG. Reduces supply-chain blast radius — a
malicious release of any of these wouldn't be picked up at next
container rebuild without a deliberate ARG bump.

Adopted from upstream nanoclaw v2 container/Dockerfile.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 3 ADOPT)
EOF
)"
```

### Task D2: `minimumReleaseAge` in `.npmrc` (ADOPT, trivial)

**Triage row (Area 6):** `minimumReleaseAge supply-chain hold | ADOPT | trivial | high | Phase 1 | Even on npm, minReleaseAge=3d in .npmrc works`. Adds a 3-day hold against newly-published packages — a malicious release has time to be detected and yanked before any v1 install picks it up.

**Files:**
- Create: `/data/nanotars/.npmrc`

- [ ] **Step 1: Confirm v1 has no `.npmrc` already**

Run: `cd /data/nanotars && test -f .npmrc && echo "EXISTS" || echo "missing"`
Expected: `missing`. If it exists, read it first and decide whether to merge or skip.

- [ ] **Step 2: Create `.npmrc` with the hold**

Create `/data/nanotars/.npmrc`:

```
# Supply-chain hold: refuse to install packages younger than 3 days.
# Gives time for malicious releases to be detected and yanked before
# they can reach this install.
minimumReleaseAge=4320

# Keep the lockfile honest — engines (Node version) is enforced strictly.
engine-strict=true
```

(`4320` minutes = 72 hours = 3 days — same as upstream nanoclaw v2's `pnpm-workspace.yaml`.)

- [ ] **Step 3: Verify the file is picked up by npm**

Run: `cd /data/nanotars && npm config get minimumReleaseAge`
Expected: `4320`.

- [ ] **Step 4: Confirm existing dependencies still install**

Run: `cd /data/nanotars && rm -rf node_modules && npm install 2>&1 | tail -10`
Expected: install succeeds. Existing deps in `package.json` are all >3 days old — none will be blocked.

- [ ] **Step 5: Commit**

```bash
cd /data/nanotars && git add .npmrc && git commit -m "$(cat <<'EOF'
build: add .npmrc with 3-day minimumReleaseAge supply-chain hold

Refuses to install npm packages younger than 3 days. Gives time for
malicious releases to be detected and yanked before they reach this
install. Mirrors upstream nanoclaw v2's pnpm minimumReleaseAge: 4320.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 6 ADOPT)
EOF
)"
```

### Task D3: Exact-version pinning in `package.json` (ADOPT, trivial)

**Triage row (Area 6):** `Version pinning (exact 4.26.0 not ^4.26.0) | ADOPT | trivial | high | Phase 1 | Reduces supply-chain blast radius for transitive bumps`. Drop the `^` from runtime + dev deps so a transitive minor bump doesn't get pulled in unexpectedly.

**Files:**
- Modify: `/data/nanotars/package.json`

- [ ] **Step 1: List current dependency ranges**

Run: `cd /data/nanotars && cat package.json | jq '.dependencies, .devDependencies'`
Record current versions. All 11 deps currently use `^X.Y.Z`.

- [ ] **Step 2: Resolve current installed versions**

Run: `cd /data/nanotars && npm list --depth=0 --json 2>/dev/null | jq '.dependencies | to_entries[] | "\(.key): \(.value.version)"'`
Record the actual installed version of each dep — those are the values to pin to.

- [ ] **Step 3: Edit `package.json` — drop the `^` prefix on every dependency**

Replace each `"package": "^X.Y.Z"` with `"package": "X.Y.Z"` using the exact installed version from Step 2. The full file should look like:

```json
{
  "name": "nanoclaw",
  "version": "1.0.0",
  "description": "Personal Claude assistant. Lightweight, secure, customizable.",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write \"src/**/*.ts\"",
    "format:check": "prettier --check \"src/**/*.ts\"",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "11.8.1",
    "cron-parser": "5.5.0",
    "pino": "9.6.0",
    "pino-pretty": "13.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "7.6.12",
    "@types/node": "22.10.0",
    "@vitest/coverage-v8": "4.0.18",
    "prettier": "3.8.1",
    "tsx": "4.19.0",
    "typescript": "5.7.0",
    "vitest": "4.0.18"
  },
  "engines": {
    "node": ">=20"
  }
}
```

(Use the values you captured in Step 2 — the above are illustrative.)

- [ ] **Step 4: Verify install + tests still work with pinned versions**

Run: `cd /data/nanotars && rm -rf node_modules package-lock.json && npm install && npm test`
Expected: clean install, all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /data/nanotars && git add package.json package-lock.json && git commit -m "$(cat <<'EOF'
build: pin deps to exact versions

Dropped ^ prefix from all runtime + dev dependencies. A transitive
minor or patch bump will not be picked up at next install without a
deliberate change to package.json — reduces supply-chain blast
radius for compromised transitive releases.

Adopted from upstream nanoclaw v2 package.json convention.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 6 ADOPT)
EOF
)"
```

---

## Group E — Skill port

### Task E1: `manage-mounts` skill (ADOPT, trivial)

**Triage row (Area 6):** `manage-mounts skill | ADOPT v2 → v1 | trivial | high | Phase 1 | UI on the existing allowlist; mostly portable`. v2 ships a `manage-mounts` skill at `.claude/skills/manage-mounts/SKILL.md` that lets the agent inspect/edit `~/.config/nanoclaw/mount-allowlist.json` from chat without the user touching JSON directly. v1 has the allowlist file (per `src/mount-security.ts`) but no skill UI.

The port is mostly verbatim — only path differences (v1's allowlist lives at `MOUNT_ALLOWLIST_PATH` defined in `src/config.ts`, which resolves to `~/.config/nanoclaw/mount-allowlist.json` — same as v2).

**Files:**
- Create: `/data/nanotars/.claude/skills/manage-mounts/SKILL.md`

- [ ] **Step 1: Verify v1's allowlist path matches v2's**

Run: `cd /data/nanotars && grep -n "MOUNT_ALLOWLIST_PATH" src/config.ts`
Expected: defines `MOUNT_ALLOWLIST_PATH = path.join(os.homedir(), '.config/nanoclaw/mount-allowlist.json')` (or equivalent). Both v1 and v2 use the same path.

- [ ] **Step 2: Look at v1's existing skill front-matter convention**

Run: `cd /data/nanotars && head -8 .claude/skills/nanoclaw-add-group/SKILL.md`
Expected: front-matter block with `name:` and `description:` fields. Mirror that style in the new skill.

- [ ] **Step 3: Create the skill directory**

```bash
mkdir -p /data/nanotars/.claude/skills/manage-mounts
```

- [ ] **Step 4: Create `/data/nanotars/.claude/skills/manage-mounts/SKILL.md`**

Write exactly the following (adapted for v1's no-setup-CLI model — uses direct file edits with JSON validation rather than v2's `npx tsx setup/index.ts`):

````markdown
---
name: manage-mounts
description: Configure which host directories nanotars agent containers can access. View, add, or remove mount allowlist entries. Triggers on "mounts", "mount allowlist", "agent access to directories", "container mounts".
---

# Manage Mounts

Configure which host directories nanotars agent containers can access. The mount allowlist lives at `~/.config/nanoclaw/mount-allowlist.json` (outside the project root, so agents cannot tamper with it from inside their containers).

## Show current config

```bash
cat ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null || echo "No mount allowlist configured (additional mounts will be BLOCKED)"
```

If the file exists, present each `allowedRoots` entry to the user with its `path`, `allowReadWrite` flag, and optional `description`. Report `nonMainReadOnly` (whether non-main groups are forced read-only) and the additional `blockedPatterns` (on top of the built-in defaults: `.ssh`, `.gnupg`, `.aws`, `credentials`, `.env`, `id_rsa`, etc. — see `src/mount-security.ts:24-45`).

## Add an allowed root

Ask the user:

1. The host path (absolute, or starting with `~/`).
2. Whether the agent needs read-write access (default: read-only).
3. An optional one-line description.

Validate the path exists:

```bash
realpath "<expanded-path>" >/dev/null 2>&1 && echo "exists" || echo "missing"
```

If the path doesn't exist, ask the user whether to add it anyway (mount validation will reject it at runtime, but adding it pre-creation is sometimes intentional).

Read the current config, splice in a new `allowedRoots` entry:

```bash
mkdir -p ~/.config/nanoclaw
node -e '
  const fs = require("fs");
  const path = "/root/.config/nanoclaw/mount-allowlist.json".replace("/root", process.env.HOME);
  const cfg = fs.existsSync(path)
    ? JSON.parse(fs.readFileSync(path, "utf8"))
    : { allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true };
  cfg.allowedRoots.push({ path: "<USER-PATH>", allowReadWrite: <true|false>, description: "<USER-DESC-OR-OMIT>" });
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
  console.log(JSON.stringify(cfg, null, 2));
'
```

Replace the `<USER-PATH>`, `<true|false>`, `<USER-DESC-OR-OMIT>` placeholders. If the user didn't provide a description, omit the `description` key entirely.

## Add a blocked pattern

Ask which path component the user wants to block (e.g., `password`, `secrets`). Append to `blockedPatterns`:

```bash
node -e '
  const fs = require("fs");
  const path = require("path").join(process.env.HOME, ".config/nanoclaw/mount-allowlist.json");
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!cfg.blockedPatterns.includes("<PATTERN>")) cfg.blockedPatterns.push("<PATTERN>");
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
'
```

## Remove an entry

Read the current config, ask which entry to remove (1-indexed), splice and write:

```bash
node -e '
  const fs = require("fs");
  const path = require("path").join(process.env.HOME, ".config/nanoclaw/mount-allowlist.json");
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  cfg.allowedRoots.splice(<INDEX>, 1);  // or cfg.blockedPatterns.splice(<INDEX>, 1)
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
'
```

## Reset to empty (no additional mounts allowed)

```bash
mkdir -p ~/.config/nanoclaw
echo '{"allowedRoots":[],"blockedPatterns":[],"nonMainReadOnly":true}' > ~/.config/nanoclaw/mount-allowlist.json
```

This is the safest default — no host directories accessible to agents beyond the workspace.

## After changes

Mount-security caches the allowlist in memory per host process. Restart the service so the new config is picked up:

- **macOS:** `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- **Linux (systemd):** `systemctl --user restart nanoclaw`
- **Foreground dev:** Stop and re-run `npm run dev`

The change takes effect for new container spawns after the restart; already-running containers continue to use the old allowlist.

## Security model

- The allowlist file is **outside the project root**, so an agent inside a container cannot modify it — they don't have a mount that reaches `~/.config/nanoclaw/`.
- Built-in `blockedPatterns` (`.ssh`, `.gnupg`, `credentials`, `.env`, etc.) are always applied even when not listed in the user config — see `src/mount-security.ts:24-45`.
- `nonMainReadOnly: true` (the default) forces non-main groups to read-only mounts regardless of `allowReadWrite`. Main group can mount read-write where the root permits.

For the full security model, see `docs/SECURITY.md`.
````

- [ ] **Step 5: Verify the skill loads**

Run: `cd /data/nanotars && find .claude/skills/manage-mounts -type f && head -5 .claude/skills/manage-mounts/SKILL.md`
Expected: `SKILL.md` present, front-matter visible (`name: manage-mounts`).

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add .claude/skills/manage-mounts/SKILL.md && git commit -m "$(cat <<'EOF'
feat(skills): port manage-mounts from upstream

Adds the manage-mounts skill so the agent can inspect and edit
~/.config/nanoclaw/mount-allowlist.json from chat without the user
touching JSON directly. Path is identical between v1 and v2 (both
use ~/.config/nanoclaw/mount-allowlist.json), so the port is
near-verbatim. Take effect on next host restart (mount-security
caches the allowlist in-memory per process).

Adopted from upstream nanoclaw v2 .claude/skills/manage-mounts.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 — Area 6 ADOPT)
EOF
)"
```

---

## Phase 1 acceptance check

After all tasks complete, verify:

- [ ] **All tasks committed individually**

Run: `cd /data/nanotars && git log --oneline d6d45f1..HEAD | wc -l`
Expected: ≥14 (one commit per task; some tasks have multiple commits).

- [ ] **Full test suite still passes**

Run: `cd /data/nanotars && npm run typecheck && npm test && cd container/agent-runner && npx vitest run`
Expected: all tests pass on both host and agent-runner.

- [ ] **No untracked files left behind**

Run: `cd /data/nanotars && git status --short`
Expected: clean.

- [ ] **Push to origin**

Run: `cd /data/nanotars && git push origin v1-archive`
Expected: clean push.

- [ ] **Record sequencing for Phase 2 follow-on**

The triage doc's Phase 2 sequencing (Cluster A migration framework, Cluster B compose pipeline, etc.) becomes the next planning chunk. Phase 2 plan should be written when Phase 1 is shipping (or shipped) — not before, to avoid stale plans.

---

## Out of scope

- **CONTRIBUTE upstream PRs** — listed at the top of this plan; tracked separately.
- **Phase 2-7 work** — sequenced later, planned just-in-time.
- **`extractReplyContext` hook** — deferred to Phase 2 Cluster C alongside Telegram pairing flow.
- **`tini` as PID 1** — deferred to Phase 2 Cluster D alongside `source-as-RO-bind-mount`.
- **`shellQuote` unit tests** — v1 has no `shellQuote` function; nothing to test.
