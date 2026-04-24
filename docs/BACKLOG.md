# Backlog

Parked work for nanotars-v2. Each item links back to its source (v1 code path in `TerrifiedBug/nanotars@v1-archive`, or an observation from a prior audit). Sorted by expected effort, then priority within effort.

Once a backlog item is scheduled for work, move it out of this file into a real task or commit — keeping the file as a stable-URL reference point, not a todo list.

## Deferred by operator decision (WhatsApp parking lot)

The operator no longer uses WhatsApp. These items are valid ports but won't be executed unless WhatsApp comes back into scope. Living source is the v1 WhatsApp plugin.

### WhatsApp — SQLite auth state
- **What**: Replace Baileys' `useMultiFileAuthState` (1000+ JSON files per session) with a single `auth.db` SQLite database; auto-migrate existing JSON on first run.
- **Why**: Eliminates pre-key file sprawl, simplifies backup/restore, faster cold-start.
- **v1 source**: `plugins/channels/whatsapp/sqlite-auth-state.js`.
- **v2 destination**: `TerrifiedBug/nanoclaw-skills` — `add-channel-whatsapp` (if it exists) or the `channels` branch WhatsApp module.
- **Effort**: M. Isolated module — port, swap the auth-state factory at session startup, migration is a one-shot `for each json → insert row`.
- **Priority**: MED if WhatsApp is ever in scope again; N/A otherwise.

### WhatsApp — magic-byte MIME detection
- **What**: WhatsApp sometimes declares incorrect MIME (`image/jpeg` for actual WebP, etc.). Check buffer magic bytes to detect actual format (PNG, JPEG, GIF, WebP, PDF) and fix file extension on mismatch before passing to Claude API.
- **Why**: Prevents Claude API 400 errors on misidentified media types.
- **v1 source**: `plugins/channels/whatsapp/index.js` — magic-byte block before media binding.
- **Effort**: S. Pure-function sniff, ~50 lines.
- **Priority**: HIGH if WhatsApp is live.

### WhatsApp — ffmpeg video thumbnail extraction
- **What**: When users send videos/GIFs, extract a JPEG thumbnail frame via `ffmpeg -frames:v 1`; fallback to Baileys' embedded `jpegThumbnail`; graceful degradation when ffmpeg isn't installed.
- **Why**: Claude sees the content instead of a raw video blob.
- **v1 source**: `plugins/channels/whatsapp/index.js` `extractThumbnail()`.
- **Effort**: M. ffmpeg in container, cache availability check, fallback path.
- **Priority**: MED.

### WhatsApp — reply context extraction
- **What**: When a user replies to a specific message, surface `<reply to="sender">quoted text</reply>` in the prompt XML. Stored in SQLite, extracted from Baileys `contextInfo`.
- **v1 source**: WhatsApp plugin preprocessing before prompt assembly.
- **Effort**: S.
- **Priority**: MED.

### WhatsApp — read receipts
- **What**: Mark messages as read after processing via Baileys `chat.sendReadReceipt()`.
- **Effort**: XS.
- **Priority**: LOW (UX nicety).

### WhatsApp — message wrapper unwrapping
- **What**: Unwrap nested WhatsApp message wrappers (`viewOnce`, `ephemeral`, `documentWithCaption`) so media bindings see the actual payload.
- **Effort**: S.
- **Priority**: MED (otherwise some messages render blank).

### WhatsApp — Agent-Teams sender-name prefix
- **What**: When subagents specify a `sender` via `send_message`, WhatsApp displays as a bold name prefix: `*Research Specialist*\n...`.
- **Effort**: XS.
- **Priority**: LOW; depends on Agent Teams workflows being active.

---

## Deferred for future scope (non-WhatsApp)

### Host singleton PID guard
- **What**: Write `host.pid` on startup, refuse to boot if existing PID is alive, clean up on graceful shutdown.
- **Why**: Prevents accidentally running `pnpm run dev` alongside the live systemd unit — both polling the same session DBs races on delivery.
- **v1 source**: v1 main initialization.
- **Effort**: XS.
- **Priority**: LOW (ops hygiene; manifests as "message delivered twice" when violated).

### `.env` permission warning
- **What**: When loading `.env`, `fs.statSync().mode` check — warn to stderr if mode > `0600` (group/other readable).
- **Effort**: XS.
- **Priority**: LOW.

### Emoji lifecycle reactions (👀 → clear → ❌)
- **What**: React 👀 on inbound receipt, clear on first output, ❌ on error. Provides visual feedback without verbose status messages.
- **v1 source**: orchestrator emoji handling + `Channel.react()` on channels that support it (Discord, Slack, Telegram reactions).
- **v2 port plan**: Wire into the routing layer where inbound messages are claimed and into the error path in delivery; emit via channel adapter's reaction API where present.
- **Effort**: S.
- **Priority**: LOW. Only meaningful for chat UIs that render reactions.

### Admin dashboard
- **What**: Web UI for health, task management, message inspection, group wiring.
- **v1 source**: v1 `src/dashboard-pusher.ts` + `.claude/skills/add-skill-dashboard/`.
- **v2 status**: Partial — `@nanoco/nanoclaw-dashboard` wired with a pusher, but v2's entity model (agents, messaging groups, session DBs) isn't represented.
- **Effort**: L (substantial rewrite against v2's DB schema).
- **Priority**: LOW unless ops needs it. Logs + sqlite queries work fine for a single-operator install.

### `/add-agent` UX skill
- **What**: Interactive skill that walks through creating a new agent group and wiring it to channels (equivalent to v1's `nanoclaw-add-agent` with pre-built agent profiles).
- **v1 source**: `.claude/skills/nanoclaw-add-agent/` (4 profiles: coordinator, dev, writer, research).
- **v2 status**: The underlying mechanism exists (agent_groups table + messaging_group_agents wiring), but creation is a manual DB/setup dance.
- **Effort**: S (skill markdown + a few helper scripts).
- **Priority**: LOW. Needed if you find yourself creating agent groups frequently.

### Caching optimizations worth verifying
- **mtime-keyed .env cache** — `src/modules/group-env/index.ts` reads on every spawn; v1 cached + invalidated on file mtime change. Probably a minor win; only matters at sustained spawn volume.
- **Streaming container logs to disk** — v1 wrote container stdout straight to a file rather than accumulating in a string buffer. v2's handling should be checked — likely already streaming, but confirm with a long-running container + memory profile.
- **Priority**: LOW. Verify first, then port if gaps.

---

## Verification-only items (probably already done in v2)

Listed for transparency — these were flagged in the v1→v2 audit as "needs verification" and may not need any porting.

- Atomic snapshot writes (write `.tmp` + rename) — v2 pattern to confirm.
- Container timeout race guard (`settled` flag to stop both timeout + close running concurrently) — verify in spawn code.
- IPC type guards / Zod validation — v2 uses DB-IPC with a schema; likely equivalent.
- Orphaned-task auto-pause (task for deleted group → auto-paused vs. crash loop) — verify scheduling module.
- TZ passthrough + UTC-suffix rejection in task validation — spot-check.
