# Slice 5 — Admin command `/help` + Telegram autocomplete: design

## Scope

Two operator-UX wins for the existing admin slash-command surface:

1. A `/help` admin command that renders all registered admin commands with one-line descriptions and usage.
2. Telegram client autocomplete via `setMyCommands` so admins typing `/` see the command menu.

Both are anchored to the existing 11 admin commands (the `ADMIN_COMMANDS` set in `src/command-gate.ts`). Slash commands stay an admin-only / main-chat-anchored surface — no plugin extensibility, no agent registration, no cross-channel parity, no centralised dispatcher refactor.

## Non-goals (explicitly out of scope)

- Plugin-extensible command registration. Plugins/skills are picked up via Claude Code's SKILL.md context, not slash commands. The marketplace doesn't need a registration API for slash commands.
- Container-side / agent-side command registration.
- Reserved-name collision prevention. (No extension surface, no collisions.)
- A heavyweight registry refactor of the 11 existing handlers — they self-register via per-module `tryHandle*` patterns and that pattern is fine.
- Per-channel command divergence. The metadata is a single list; if a future channel doesn't support setMyCommands, that's the channel plugin's concern.

## Architecture

A single command-metadata table in `src/command-gate.ts`. Every admin slash-command has exactly one row. Adding or changing a command means editing one place. The existing handler-dispatch pattern (per-module `tryHandle*Command` calls) is preserved; the metadata table is purely additive.

The Telegram plugin reads the command list (written by the host on boot to a known JSON path) and calls Telegram's `setMyCommands` API on connect. Future channel plugins can do the same, or skip it.

## Components

### 1. `src/command-gate.ts` — extend the metadata source of truth

Today:
```ts
const ADMIN_COMMANDS = new Set<string>([
  '/grant', '/revoke', '/list-users', '/list-roles', '/register-group',
  '/delete-group', '/restart', '/pause', '/resume', '/rebuild-image',
  '/pair-telegram',
]);
```

New:
```ts
export interface AdminCommandMeta {
  /** The slash-prefixed command name, e.g. '/grant'. */
  name: string;
  /** One-line description for /help and Telegram autocomplete. */
  description: string;
  /** Argument usage hint, e.g. '<user_id> <role>'. Empty string if no args. */
  usage: string;
}

export const ADMIN_COMMANDS = new Map<string, AdminCommandMeta>([
  ['/grant',          { name: '/grant',          description: 'Grant a role to a user.',                usage: '<user_id> <role>' }],
  ['/revoke',         { name: '/revoke',         description: 'Revoke a role from a user.',             usage: '<user_id> <role>' }],
  ['/list-users',     { name: '/list-users',     description: 'List all known users with their roles.', usage: '' }],
  ['/list-roles',     { name: '/list-roles',     description: 'List role definitions.',                 usage: '' }],
  ['/register-group', { name: '/register-group', description: 'Register the current chat as a group.',  usage: '<folder>' }],
  ['/delete-group',   { name: '/delete-group',   description: 'Delete a registered group.',             usage: '<folder>' }],
  ['/restart',        { name: '/restart',        description: 'Restart all agent containers.',          usage: '' }],
  ['/pause',          { name: '/pause',          description: 'Pause processing for an agent group.',   usage: '<folder>' }],
  ['/resume',         { name: '/resume',         description: 'Resume processing for an agent group.',  usage: '<folder>' }],
  ['/rebuild-image',  { name: '/rebuild-image',  description: 'Force-rebuild a per-agent-group image.', usage: '<folder>' }],
  ['/pair-telegram',  { name: '/pair-telegram',  description: 'Generate a 4-digit pairing code.',       usage: '' }],
  ['/help',           { name: '/help',           description: 'List all admin commands.',               usage: '' }],
]);
```

`isAdminCommand(text)` keeps its current shape — `Map.has(name)` works identically to `Set.has(name)`, so all existing call sites (`src/ipc/auth.ts:58, 66`, the four bespoke handler modules) compile unchanged.

New helpers (added to `command-gate.ts`):

```ts
export function getAdminCommandMeta(name: string): AdminCommandMeta | undefined {
  return ADMIN_COMMANDS.get(name);
}

export function listAdminCommands(): AdminCommandMeta[] {
  return [...ADMIN_COMMANDS.values()].sort((a, b) => a.name.localeCompare(b.name));
}
```

The exact descriptions / usage strings above are starting drafts — the implementation plan will tighten any that are off and confirm against each handler's actual behavior.

### 2. `src/help-command.ts` — new tiny handler module

Same shape as `src/lifecycle-admin-commands.ts` (the canonical pattern for "host-handled admin command that produces a text response"). Single exported function:

```ts
export interface TryHandleHelpArgs {
  command: string;
  userId: string;
  agentGroupId: string;
}

export interface TryHandleHelpResult {
  handled: boolean;
  /** Text to send back to the requester. Always set when handled=true. */
  output?: string;
}

export function tryHandleHelpCommand(args: TryHandleHelpArgs): TryHandleHelpResult {
  if (args.command.trim().split(/\s+/)[0] !== '/help') {
    return { handled: false };
  }

  const decision = checkCommandPermission(args.userId, '/help', args.agentGroupId);
  if (decision.allowed === false) {
    return { handled: true, output: `Sorry — /help is admin-only (${decision.reason}).` };
  }

  const lines = ['*Admin commands:*'];
  for (const meta of listAdminCommands()) {
    const usage = meta.usage ? ` ${meta.usage}` : '';
    lines.push(`${meta.name}${usage} — ${meta.description}`);
  }
  return { handled: true, output: lines.join('\n') };
}
```

Wiring point: the existing IPC command-handling sequence (currently a chain of `tryHandle*Command` calls in `src/ipc/tasks.ts` or wherever the dispatch is) gets one more entry: `tryHandleHelpCommand(...)`. Output goes back through the standard router path the other admin handlers use. Identification of the exact wiring file is implementation work.

### 3. `data/admin-commands.json` — host-side writeout for channel plugins

On host boot, after `command-gate.ts` is loaded, write a JSON file:

```json
[
  { "name": "/grant",   "description": "Grant a role to a user.",   "usage": "<user_id> <role>" },
  { "name": "/revoke",  "description": "Revoke a role from a user.", "usage": "<user_id> <role>" },
  ...
]
```

Path: `data/admin-commands.json` (under the existing `DATA_DIR` constant). Plugins that want to call their channel's autocomplete API read this file on connect.

The host writes it once on boot. If admin commands change at runtime (they don't today, but could in future via plugin install), the host re-writes the file and emits an IPC event the plugin can listen for. For this slice, write-once-on-boot is sufficient.

Implementation: small helper exported from `src/command-gate.ts` (or co-located in a new `src/admin-commands-export.ts` if the export logic grows beyond ~20 lines), invoked once from `src/index.ts` at boot, immediately after `initDatabase()`.

### 4. Telegram plugin extension (marketplace PR)

In `TerrifiedBug/nanotars-skills` repo, plugin `nanotars-telegram`'s `index.js` (or wherever the bot startup happens):

```js
async function setupAutocomplete(bot, dataDir) {
  const cmdsPath = path.join(dataDir, 'admin-commands.json');
  let cmds;
  try {
    cmds = JSON.parse(await fs.promises.readFile(cmdsPath, 'utf-8'));
  } catch (err) {
    logger.warn({ err }, 'admin-commands.json not found; skipping setMyCommands');
    return;
  }

  // Telegram Bot API: setMyCommands accepts an array of { command, description }.
  // The 'command' value is the bare name without the leading slash.
  const telegramCmds = cmds.map((c) => ({
    command: c.name.replace(/^\//, ''),
    description: `${c.description}${c.usage ? ` (${c.usage})` : ''}`.slice(0, 256),
  }));

  await bot.api.setMyCommands(telegramCmds, {
    scope: { type: 'chat_administrators' },
  });
}
```

Called once after `bot.start()`. Scope `chat_administrators` means autocomplete only appears for chat admins, matching the host-side gate semantics.

The marketplace PR is filed after the core changes land on `v1-archive`, so the plugin can be tested against a working host.

## Data flow

**`/help` invocation:**

1. Operator types `/help` in main chat.
2. Telegram plugin delivers the inbound message via the standard IPC inbound path.
3. The host's command-handling chain runs `tryHandleHelpCommand(args)` before any agent dispatch.
4. The handler (a) gates via `checkCommandPermission`, (b) renders `listAdminCommands()` into a single text block, (c) returns `{ handled: true, output: '<text>' }`.
5. The host's existing outbound router sends `output` back through the same channel/chat the message arrived on.
6. The agent never sees the message.

**Telegram autocomplete:**

1. Host boots; `command-gate.ts` is loaded.
2. Host writes `data/admin-commands.json` from the `ADMIN_COMMANDS` Map.
3. Telegram plugin starts; after `bot.start()` resolves, it reads `data/admin-commands.json` and calls `setMyCommands` with scope `chat_administrators`.
4. Operator opens Telegram, types `/`; client shows the admin command list with descriptions.

## Error handling

- **`/help` invoked by non-admin:** existing `checkCommandPermission` returns `{ allowed: false, reason: '<admin-only|...>' }`; the handler returns a polite refusal in `output`.
- **`data/admin-commands.json` missing or unreadable in the Telegram plugin:** plugin logs a warning and skips `setMyCommands`. The bot still works; autocomplete just doesn't appear. Not fatal.
- **Telegram API rejects `setMyCommands`:** plugin logs the error and continues. Bot still works.
- **Metadata Map drift between commit and runtime:** the single source of truth (`ADMIN_COMMANDS` Map) makes this impossible — there's nowhere else for the metadata to live.

## Testing

- **`src/__tests__/command-gate.test.ts`** — extend with:
  - `isAdminCommand` still recognises every command (regression coverage from the Set→Map switch).
  - `getAdminCommandMeta('/grant')` returns the right metadata.
  - `listAdminCommands()` returns all 12 commands sorted by name.

- **`src/__tests__/help-command.test.ts` (new)** — covers:
  - `/help` from non-admin → handled=true, output contains "admin-only".
  - `/help` from admin → handled=true, output starts with "*Admin commands:*" and contains every command name.
  - `/help extra args` → still handled (we ignore args; usage is the docstring).
  - Non-`/help` command → handled=false, no output.

- **No integration / e2e test added** — `/help` is a pure function over the metadata Map. The existing IPC tests cover the dispatch chain.

- **Telegram plugin** — manual test post-merge: install the plugin against a host that has `data/admin-commands.json`, open a chat, confirm `/` autocomplete shows.

## File structure

| File | Change | Purpose |
|---|---|---|
| `src/command-gate.ts` | Modify | `ADMIN_COMMANDS` becomes a `Map<name, meta>`; add `getAdminCommandMeta`/`listAdminCommands`. |
| `src/help-command.ts` | Create | `tryHandleHelpCommand` handler. |
| `src/index.ts` | Modify | Wire `tryHandleHelpCommand` into the IPC command-handling chain; call admin-commands JSON export on boot. |
| `src/admin-commands-export.ts` | Create (optional) | Helper that writes `data/admin-commands.json`. Inline in `command-gate.ts` if it stays ≤20 LOC. |
| `src/__tests__/command-gate.test.ts` | Modify | New test cases for the Map/meta accessors. |
| `src/__tests__/help-command.test.ts` | Create | `/help` rendering + admin gate. |
| `data/admin-commands.json` | Generated at runtime | Source of truth that channel plugins consume. (Not committed; appears under `data/` which is gitignored.) |
| (marketplace) `plugins/nanotars-telegram/index.js` | Modify in separate PR after core lands | Read JSON on connect, call `setMyCommands`. |

Test files are colocated under `src/__tests__/`. No new test runners; existing Vitest config picks them up.

## Effort estimate

~1 day total:
- ~2-3h core changes (Map switch, /help handler, JSON writeout, wiring, tests).
- ~1h Telegram marketplace plugin patch + manual test.
- ~30min BACKLOG reconciliation.

## Open implementation choices

These are concrete decisions the implementation plan will lock down:

1. **Where `tryHandleHelpCommand` is wired into the IPC command chain** — needs grepping `src/ipc/` for the existing `tryHandle*Command` dispatch order. The implementation plan identifies the exact file.
2. **Description and usage strings for each command** — the strings drafted in §1 above are starting drafts; the plan will confirm them against each handler's actual behavior.
3. **Whether the Telegram autocomplete is one PR per channel or batched** — only Telegram is in-tree today; defer this until a second channel plugin needs autocomplete.
