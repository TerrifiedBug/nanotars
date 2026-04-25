## Area: Channels and media handling

### Functional inventory

- **v1-archive:** Channels are first-class plugins. The `Channel` interface (`src/types.ts:96-107`) declares 6 required + 4 optional methods (`name`, `connect`, `sendMessage(jid, text, sender?, replyTo?)`, `isConnected`, `ownsJid`, `disconnect`, optional `sendFile`, `react`, `refreshMetadata`, `listAvailableGroups`). Plugin-loader discovers any `plugins/<name>/plugin.json` (or `plugins/channels/<name>/plugin.json`) with `channelPlugin: true`, calls `onChannel(ctx, config)` as a factory, then `connect()` (`docs/CHANNEL_PLUGINS.md:97-106`). Host is channel-agnostic — `routeOutbound(channels, jid, text, sender?, replyTo?, registry?)` (`src/router.ts:54-80`) picks the first channel where `ownsJid(jid) && isConnected()`; `routeOutboundFile` (`src/router.ts:82-97`) is the file-path equivalent. JIDs are per-channel namespaced (`@g.us`/`@s.whatsapp.net` for WhatsApp, `tg:<chatId>` for Telegram, `dc:<channelId>` for Discord — `docs/CHANNEL_PLUGINS.md:349-355`). Inbound flows back through `OnInboundMessage` + `OnChatMetadata` callbacks injected at init (`src/types.ts:109-115`). The 27 channel implementations are gitignored (`plugins/channels/` is empty except `.gitkeep`); canonical reference is the WhatsApp template at `.claude/skills/add-channel-whatsapp/files/index.js` (~622 lines at commit `90955d9`). The MCP `send_file` lives in `container/agent-runner/src/ipc-mcp-stdio.ts:373-433` and writes JSON IPC the host reads in `src/ipc/messages.ts:46-91`. MIME inference is **extension-only** (`src/ipc/messages.ts:14-27`) — no magic-byte sniffing. Reactions use Baileys `key = { remoteJid, id, fromMe, participant? }` semantics (WA template lines 371-387). Reply-quoting is extracted from `extendedTextMessage.contextInfo.quotedMessage` into `reply_context: { sender_name, text }` on `NewMessage` (`/tmp/v1-wa-index.js:233-258`, `src/types.ts:45-48`). ffmpeg thumbnail extraction lives entirely in the WhatsApp template (`/tmp/v1-wa-index.js:397-428`): probes `ffmpeg -version` on connect, runs `ffmpeg -i <video> -frames:v 1 -q:v 2 -y <thumb.jpg>` for inbound videos with a 10s timeout, falls back to Baileys' embedded `jpegThumbnail`. GIFs (Baileys' `gifPlayback`) get the thumbnail returned as `type: 'image'` so the agent's vision sees them. No shared media handling in core. Sender-name override (`sender?` on `sendMessage`) drives Telegram swarm-pool sub-agent identities.
- **upstream/main:** Typed adapters wired through a Chat-SDK middleware. `ChannelAdapter` (`src/channels/adapter.ts:111-166`) is shaped around `(platformId, threadId)` rather than JID. Required: `name`, `channelType`, `supportsThreads: boolean`, `setup(config)`, `teardown()`, `isConnected()`, `deliver(platformId, threadId, msg) -> Promise<string|undefined>`. Optional: `setTyping`, `syncConversations`, `subscribe`, `openDM`. Adapters self-register on import via `registerChannelAdapter(name, registration)` (`channel-registry.ts:25-27`); `initChannelAdapters` retries `NetworkError` setups with `[2, 5, 10]s` backoff (`channel-registry.ts:10-94`). Inbound is push via four `ChannelSetup` callbacks (`onInbound`, `onInboundEvent` carrying `replyTo`, `onMetadata`, `onAction` — `adapter.ts:9-26`). Routing in `src/router.ts:144-317`: thread-policy strip for non-threaded platforms, mention from `event.message.isMention` (adapter-set, not regex-matched, `router.ts:328-336`), per-agent fan-out through `evaluateEngage()` (modes: `pattern` / `mention` / `mention-sticky`, `router.ts:339-370`), each engagement gets its own session and wake. Outbound delivery is poll-based: `src/delivery.ts:122-149` polls each session's `outbound.db` read-only, filters against `inbound.db`'s `delivered` table, dispatches by `(channelType, platformId, threadId)` to `ChannelDeliveryAdapter` (`delivery.ts:53-63`) → `getChannelAdapter(channelType).deliver(...)`. The Chat SDK bridge (`src/channels/chat-sdk-bridge.ts:120-482`) wraps `@chat-adapter/<platform>` + a `Chat` instance, hooks four SDK dispatch paths (`onSubscribedMessage`, `onNewMention`, `onDirectMessage`, `onNewMessage(/./)` — lines 221-264), routes ask-question cards via `adapter.postMessage({ card, fallbackText })`, edits via `adapter.editMessage`, reactions via `adapter.addReaction`, splits text over `maxTextLength` on paragraph→line→space→hard cuts (`splitForLimit`, lines 104-118), and serializes `ChatMessage` for DB storage with `attachment.fetchData()` base64-inlined (`messageToInbound`, lines 128-191). Telegram is the only checked-in adapter at trunk (`src/channels/telegram.ts`): builds the bridge with `supportsThreads: false`, layers a pairing interceptor over `onInbound` (`telegram-pairing.ts`, `telegram.ts:212-295`), wraps `deliver()` to dispatch images/videos/audio by extension to `sendPhoto`/`sendVideo`/`sendAudio` (lines 78-116, 326-352), and applies `sanitizeTelegramLegacyMarkdown` (`telegram-markdown-sanitize.ts:15-55`). CLI is an always-on local-socket adapter (`src/channels/cli.ts:1-277`) doubling as admin transport (`onInboundEvent` carries `replyTo: DeliveryAddress`). Reactions are agent-callable via `add_reaction` MCP, which writes `{operation:'reaction', messageId, emoji}` to `messages_out`; bridge `deliver` invokes `adapter.addReaction` (`chat-sdk-bridge.ts:364-367`). The chat-adapter composite-id format is `"<chatId>:<msgId>"` (Telegram) or `"<guildId>:<channelId>:<msgId>"` (Discord); the host's per-agent fan-out suffix `:<agentGroupId>` (`router.ts:464-467`) broke the chat-adapter's decode — fixed `5e93609` by reading the original composite from `content.id`. Inbound media is base64-inline (`chat-sdk-bridge.ts:137-160`); no ffmpeg thumbnailing. Voice transcription lives in separate add-on skills, not the Telegram adapter. Agent-side destinations table (`container/agent-runner/src/destinations.ts:1-135`) is the inbound.db ACL the host re-validates at delivery (`delivery.ts:289-311`).

### Implementation comparison

#### Adapter / Channel interface shape

- **Functionality:** Define the contract a single channel implementation must meet so the rest of the system can be channel-agnostic.
- **v1 approach:** `Channel` (`src/types.ts:96-107`). Per-method shape — methods take a `jid` string, `connect()` is the lifecycle entry, `sendMessage` / `sendFile` / `react` are direct synchronous(-ish) IO surfaces, plus `ownsJid()` for routing. Inbound is via callbacks injected through `ChannelPluginConfig` (`docs/CHANNEL_PLUGINS.md:222-241`). Manifest declares `channelPlugin: true`, optional `authSkill`, plus standard plugin manifest fields; loader treats them differently only by initializing them before non-channel plugins (`docs/CHANNEL_PLUGINS.md:97-106`). Sender override carried on `sendMessage(jid, text, sender?, replyTo?)`; `replyTo` is a platform message id.
- **v2 approach:** `ChannelAdapter` (`src/channels/adapter.ts:111-166`). Single `deliver(platformId, threadId, OutboundMessage)` for all outbound (text, edit, reaction, ask_question card, file attachments) — discriminated by `OutboundMessage.content.operation` and `kind`. `setup(ChannelSetup)` takes the four-callback bundle (`onInbound`, `onInboundEvent`, `onMetadata`, `onAction`). Adds `supportsThreads`, `setTyping`, `syncConversations`, `subscribe(platformId, threadId)` (mention-sticky engage), `openDM(userHandle)` (cold-DM resolution for approvals/host-initiated notifications). The `replyTo` concept is moved up to the event level (`InboundEvent.replyTo: DeliveryAddress`) for admin transports rather than being a per-message id.
- **Verdict:** v2's interface is genuinely better-shaped *for v2's architecture* — the adapter doesn't need to know about JID parsing, mention logic, or text vs. file routing because the bridge / router handle those. But v1's interface is a better fit for v1's monolithic core. The v2 shape only pays off when you have the entity model (messaging_groups, agent_groups, sessions) and the two-DB delivery loop behind it. **Verdict: SKIP-ARCH** for the interface as a whole; individual ergonomic ideas (`supportsThreads`, `subscribe`, `openDM`) are isolated enough to consider individually below.

#### Outbound text routing

- **Functionality:** Get an agent's text reply to the right platform.
- **v1 approach:** `routeOutbound(channels, jid, text, sender?, replyTo?, registry?)` walks channels and dispatches to first `ownsJid && isConnected` (`src/router.ts:54-80`). Plugin-registry's `runOutboundHooks` can suppress the message (line 70-74). Secrets redacted via `redactSecrets()` before send.
- **v2 approach:** Decoupled poll-based. Container writes `messages_out`; host's `deliverSessionMessages` reads, filters against `delivered`, applies per-source-agent permission check (`delivery.ts:274-311`), redacts via `secret-redaction/index.ts`, calls `deliveryAdapter.deliver(...)` → `getChannelAdapter(channelType).deliver(...)`.
- **Verdict:** v2's poll-based delivery is better (idempotent retry, `MAX_DELIVERY_ATTEMPTS=3`, separate `delivered` ack — `delivery.ts:33, 209-216`) but depends on the two-DB session model. v1's fire-and-forget works fine at v1's scale. **Verdict: SKIP-ARCH.**

#### Outbound file routing & MIME / inline-media dispatch

- **Functionality:** Deliver a file from agent's workspace as platform-rendered media (image inline, video inline, audio inline) when possible, fallback to document.
- **v1 approach:** `send_file` MCP writes JSON IPC (`ipc-mcp-stdio.ts:373-433`); host validates path under `/workspace/group/`, translates to host path, checks symlink-resolved containment (`src/ipc/messages.ts:46-91`), reads buffer, MIME by **extension only** (`messages.ts:14-27`), calls `routeOutboundFile`. WhatsApp `sendFile()` dispatches by MIME prefix: `image/*` → `{ image: buffer }`, `video/*` → `{ video: buffer }`, `audio/*` → `{ audio: buffer }`, else `{ document, mimetype, fileName }` (`/tmp/v1-wa-index.js:349-369`). Telegram template at v1 head **does not implement `sendFile`** — `routeOutboundFile` fails silently.
- **v2 approach:** Container's `send_file` copies to `outbox/<id>/<filename>` and writes `messages_out` content `{text, files:[filename]}` (`mcp-tools/core.ts:134-178`). Host reads buffers via `readOutboxFiles()` in `delivery.ts:351-354`. Bridge default sends through `adapter.postMessage({ markdown, files })` — chat-adapter wraps everything as `sendDocument` for Telegram. v2 Telegram adapter overrides `deliver` (`channels/telegram.ts:325-352`) and dispatches by extension → Bot API `sendPhoto`/`sendVideo`/`sendAudio` via multipart (lines 78-116). Single-file only; multi-file / unmapped extensions fall through to bridge.
- **Verdict:** **v2 is better for Telegram** — explicit typed-API dispatch closes a real v1 Telegram-template gap. **For WhatsApp: equal** — Baileys already routes by content-key in both. **Verdict: ADOPT** the typed-media routing for v1's Telegram template (port `channels/telegram.ts:25-116`). Effort: small. Confidence: high.

#### Magic-bytes MIME detection

- **Functionality:** Detect MIME from file content rather than extension to handle mis-named files / extension-spoofing.
- **v1 approach:** **Not present.** Both `src/ipc/messages.ts:14-27` and the WhatsApp template's `sendFile()` use extension-based MIME mapping. Baileys does its own internal sniffing on outbound media types but that's library-internal, not application code.
- **v2 approach:** **Not present either.** `channels/telegram.ts:29-62` uses `MEDIA_EXTENSIONS` lookup; the Chat SDK adapters use whatever the platform's upload API requires (often extension-derived too).
- **Verdict:** Neither side has magic-bytes detection. The triage spec flagged this as "likely already in v1 (Danny's own work)" — that appears to be a misremembering of the **ffmpeg thumbnail extraction** work (commit `90955d9`), which is a separate concern (see below). **Verdict: SKIP** — there is nothing to port. Confidence: high. If magic-bytes detection is desired as new work, it would be greenfield in either codebase.

#### ffmpeg thumbnail extraction for video media

- **Functionality:** When inbound message contains a video, extract a JPEG thumbnail so the agent's vision model can preview the frame; for GIFs (Baileys' `gifPlayback` videos) substitute the thumbnail as the image so the agent can actually see the GIF.
- **v1 approach:** Lives in the WhatsApp template (`.claude/skills/add-channel-whatsapp/files/index.js:397-428`, commit `90955d9`). Probes `ffmpeg -version` on connect; `extractThumbnail()` runs `ffmpeg -i <video> -frames:v 1 -q:v 2 -y <thumb>` (10s timeout), falls back to Baileys' embedded `jpegThumbnail`. GIFs (Baileys' `gifPlayback`) return `type:'image'` substituting the thumbnail; regular videos get `type:'video' + thumbnailPath`. Host sets `mediaPath`/`mediaHostPath` on `NewMessage`.
- **v2 approach:** **Not present.** The bridge fetches attachment data via `att.fetchData()` and stores it base64-inline (`chat-sdk-bridge.ts:149-156`); there is no extraction or transcoding step. For Telegram, `videoMessage` arrives as a chat-adapter attachment with no automatic thumb generation.
- **Verdict:** **v1 wins clearly here.** This is Danny's own work and it's a meaningful UX feature — without it the agent literally cannot see what GIF was sent. v2 has no equivalent. **Verdict: KEEP** in v1 and **CONTRIBUTE** the pattern upstream (effort: medium for upstream — needs to live as a post-`messageToInbound` hook in the bridge, or as channel-specific logic in any native adapter; not all chat-adapter platforms expose the raw video buffer the same way). Confidence: high (bug exists in v2; verified 2026-04-25 via timeline observation 8937 noting voice transcription is a separate skill — same is presumably true here).

#### Reactions

- **Functionality:** React to a message with an emoji.
- **v1 approach:** Agent's `react` MCP writes IPC (`ipc-mcp-stdio.ts:435-463`); `processMessageIpc('react')` calls `deps.react(jid, messageId, emoji)`. Channels implement `react?(jid, messageId, emoji, participant?, fromMe?)` (`src/types.ts:101`). WA builds Baileys `key = { remoteJid, id, fromMe, participant? }` (`/tmp/v1-wa-index.js:371-387`). Telegram template calls `bot.api.setMessageReaction`. Message ids are platform-native, looked up via `getMessageMeta(messageId, chatJid)` (`src/db/messages.ts:204-213`).
- **v2 approach:** Agent's `add_reaction` writes `messages_out` `{operation:'reaction', messageId, emoji}` (`mcp-tools/core.ts:262`); bridge calls `adapter.addReaction` (`chat-sdk-bridge.ts:364-367`). Chat-adapter expects composite id (e.g. `"8236653927:118"`); host's router suffixes row ids with `:<agentGroupId>` (`router.ts:464-467`) which broke the parser. Commit `5e93609` (2026-04-25) reads the original composite from `content.id` instead.
- **Verdict:** **v1 reactions are simpler and don't have the composite-id hazard** because v1 doesn't suffix message ids per-agent (no fan-out). The bug is v2-internal. **Verdict: KEEP** v1's pattern; `5e93609` is not portable. Confidence: high.

#### Reply-quoting

- **Functionality:** When a message is a reply, surface the quoted message's content + sender to the agent.
- **v1 approach:** `ReplyContext: { sender_name, text|null }` on `NewMessage` (`src/types.ts:45-48`). WA channel walks `extendedTextMessage.contextInfo` / `imageMessage.contextInfo` / etc., dereferences `quotedMessage`, special-cases the bot replying to itself (`/tmp/v1-wa-index.js:233-258`). Telegram channel uses `ctx.message.reply_to_message`. Formatter inserts `<reply to="{sender_name}">{text or [non-text message]}</reply>` (`src/router.ts:31-44`).
- **v2 approach:** `ReplyContextExtractor` is a per-channel function (`chat-sdk-bridge.ts:43-44`); the bridge calls it on `message.raw` and stores the result on the serialized JSON as `replyTo: { text, sender }` (`chat-sdk-bridge.ts:163-167`). Telegram's extractor is `channels/telegram.ts:140-148`. The container's formatter renders it.
- **Verdict:** **Neutral.** v2's structure is slightly cleaner (per-channel hook vs. per-channel inline parsing) and runs at the bridge layer rather than the channel implementation. v1's is functionally identical at the data-model level. The hook pattern is a small improvement worth borrowing if v1 ever lands a new channel type. **Verdict: SKIP-ARCH** for the architectural piece (bridge-layered hook). Optional `ADOPT` for the `extractReplyContext` per-channel-callable shape (effort: trivial; confidence: medium — net win is small).

#### Message ID composite formats / threading conventions

- **Functionality:** Identify a single message globally so it can be edited / reacted to / replied to later.
- **v1 approach:** Platform-native id stored verbatim. WA = Baileys `msg.key.id` (e.g. `3EB0C1...`). Telegram = `ctx.message.message_id` stringified. JID uniqueness is per-chat (`(id, chat_jid)` is the natural key in `messages` — `src/db/messages.ts:204-213`).
- **v2 approach:** Two layers. (1) `messages_in.id` and `messages_out.id` are host/container-generated `msg-<ts>-<rand>` strings, independent of platform ids. (2) The chat-adapter's composite id is platform-shaped (`"<chatId>:<msgId>"` for Telegram per `channels/telegram.ts:115`, `"guildId:channelId:msgId"` for Discord) and lives inside the JSON `content.id` — distinct from the column id. The router additionally suffixes the inbound row id with `:<agentGroupId>` for fan-out uniqueness (`router.ts:464-467`).
- **Verdict:** v2 has more layers because it has more concerns (per-agent fan-out, two-DB seq scheme, edit/react targeting). v1 doesn't need them. **Verdict: SKIP-ARCH.**

#### JID / platform-id semantics (`ownsJid` vs. `channelType`)

- **Functionality:** Decide which channel handles a given destination address.
- **v1 approach:** Each channel claims a JID prefix/suffix via `ownsJid()` (`docs/CHANNEL_PLUGINS.md:347-355`). One opaque string per address.
- **v2 approach:** Address is a triple: `(channelType, platformId, threadId)`. `getChannelAdapter(channelType)` is the lookup; the adapter's own encoding (`telegram:<chatId>`, `discord:guildId:channelId`) is opaque to core. Adapter declares `supportsThreads` to let the router strip/preserve `threadId` (`router.ts:147-150`).
- **Verdict:** **v2's structure is cleaner** for multi-channel platforms (Discord guild+channel, Slack workspace+channel) where a single string gets brittle. v1's is fine for the platforms it handles but accumulates ad-hoc parsing. **Verdict: SKIP-ARCH** — porting the triple address would cascade through every storage table and IPC payload.

#### Subscribe / mention-sticky

- **Functionality:** After a thread first engages the bot, follow-up messages in the same thread should keep firing without requiring another @mention.
- **v1 approach:** Not modeled. Trigger pattern (`@TARS`) is per-message; threading isn't a first-class concept. Group-vs-DM distinction is the only auto-engage shortcut.
- **v2 approach:** Adapter's optional `subscribe(platformId, threadId)` (`adapter.ts:139-148`). Router invokes it on the first engage with `engage_mode='mention-sticky'` (`router.ts:276-291`); follow-ups resolve via `findSessionForAgent(...)` returning truthy (`router.ts:359-369`). Bridge's implementation hits `state.subscribe(threadId)` on the SqliteStateAdapter (`chat-sdk-bridge.ts:454-461`).
- **Verdict:** v2-only feature, depends on threading semantics v1 doesn't have. **Verdict: SKIP-ARCH** — the feature is intelligible in isolation but its router integration assumes v2's wiring/session model.

#### openDM (cold-DM resolution)

- **Functionality:** Open a DM channel for a user who hasn't messaged the bot yet (host-initiated approval prompts, pairing handshakes).
- **v1 approach:** Not present. v1 only sends to JIDs that have already been seen / registered.
- **v2 approach:** `openDM?(userHandle): Promise<string>` (`adapter.ts:151-165`); bridge delegates to `adapter.openDM` and returns `channelIdFromThreadId(threadId)` (`chat-sdk-bridge.ts:474-479`). Comment notes Telegram/WA/iMessage skip it (handle == DM channel id).
- **Verdict:** Useful primitive but only matters once you have things like approval cards, owner-DM escalation, channel-request approvals — most of which are v2-only modules. **Verdict: SKIP-ARCH.**

#### Chat SDK bridge as middleware

- **Functionality:** Reuse the third-party `@chat-adapter/*` packages plus the `chat` lib for Discord/Slack/Telegram/etc., adapting their abstractions to NanoClaw's `ChannelAdapter` shape.
- **v1 approach:** No middleware. Each plugin owns its SDK integration directly (Baileys for WA, grammy for Telegram, etc.).
- **v2 approach:** `createChatSdkBridge(config)` (`chat-sdk-bridge.ts:120-482`, ~480 LOC) instantiates a `Chat`, hooks four SDK dispatch paths, marshals SDK ↔ `InboundMessage`, splits long text, drives a Gateway listener (Discord) or webhook server (others, line 343-346), exposes optional `openDM`. Per-channel `transformOutboundText` and `extractReplyContext` hooks let a new chat-adapter platform land in tens of lines.
- **Verdict:** The bridge is glue around vendor packages v1 doesn't depend on — porting requires adopting `@chat-adapter/*` and `chat` wholesale. v1's plugin-loader model already ships 27 channels via templates. **Verdict: SKIP-ARCH** for the bridge as a unit. Component ideas — `transformOutboundText`, `extractReplyContext`, `splitForLimit` — are individually portable. Confidence: high.

#### CLI always-on channel

- **Functionality:** Ship-with-trunk channel that talks to the local terminal via Unix socket; doubles as admin transport with `to`/`reply_to` addressing.
- **v1 approach:** Not present. Closest equivalent is one-off scripts / direct DB poking.
- **v2 approach:** `src/channels/cli.ts:1-277`. Listens on `data/cli.sock` (chmod 0600), one chat client at a time, JSON-line wire format, supports the admin-transport `onInboundEvent` path with `replyTo`. Always available; no credentials needed.
- **Verdict:** Genuinely useful for dev/debug/automation flows; mostly self-contained. The admin-transport (`onInboundEvent` with `replyTo`) is bound to v2's `ChannelSetup` shape and the router's `replyTo` propagation — that part is hard to port. The basic "talk to your agent from a terminal" loop could be lifted as a v1 channel plugin. **Verdict: ADOPT** the basic socket loop as a v1 channel plugin (effort: medium; confidence: medium — depends on whether v1's IPC/file-watcher model can deliver replies promptly enough). Skip the admin-transport piece until v1 grows a comparable `replyTo` concept.

#### Telegram pairing / chat-of-origin attestation

- **Functionality:** Prove that the operator setting up a chat actually owns the chat. BotFather hands out tokens with no user binding so anyone who guesses a bot username can DM it.
- **v1 approach:** Not present. v1's setup model is "register the JID by hand from the main group" — implicit trust that the operator has the right JID.
- **v2 approach:** `src/channels/telegram-pairing.ts:1-340` + interceptor in `telegram.ts:212-295`. Setup creates a 4-digit code; operator echoes it back from the chat to register; on match the chat is recorded, the user is upserted, and (if no owner exists) promoted to owner. JSON file storage with in-process mutex; sweep keeps last 50; codes don't expire (consumed on match or invalidated on wrong guess).
- **Verdict:** Solves a real pre-existing security gap. **Verdict: ADOPT** as a v1 channel-side utility for any channel where the trust model is similar (Telegram, possibly Slack DMs). Effort: medium (storage, code generation, interceptor pattern); confidence: medium — depends on v1 having a setup flow the code can be echoed *into* (and its integration with v1's trust model — v1 has `requiresTrigger` per group but no first-class user-roles).

#### Telegram legacy-Markdown sanitization

- **Functionality:** Repair `**bold**` / list-bullet / unbalanced-delimiter outbound markdown to satisfy Telegram's legacy Markdown parse mode (which `@chat-adapter/telegram` hardcodes).
- **v1 approach:** Not needed — v1 channels send raw text directly via grammy / Baileys APIs.
- **v2 approach:** `telegram-markdown-sanitize.ts:15-55`. Regex-driven sanitizer wired through `transformOutboundText`. Documented as a workaround that should retire once `vercel/chat#367` lands.
- **Verdict:** v2-only because it's a workaround for a v2-only dependency. **Verdict: SKIP** unless v1 ever adopts `@chat-adapter/telegram`.

#### Inbound media handling (download, base64, attachment metadata)

- **Functionality:** Make platform attachments visible to the agent.
- **v1 approach:** Per-channel. WA downloads via Baileys `downloadMediaMessage(msg, 'buffer', {})`, writes to host `groups/<folder>/media/`, returns `mediaPath` (container-relative) + `mediaHostPath` (absolute). The agent sees a text reference like `[image: /workspace/group/media/abc.jpg]` (`/tmp/v1-wa-index.js:266-289`). Telegram template doesn't download — just inserts placeholders like `[Photo]` (lines 165-185 of the Telegram template).
- **v2 approach:** Bridge fetches `att.fetchData()` and stores base64 inline on the InboundMessage's serialized content (`chat-sdk-bridge.ts:137-160`). Formatter renders an `<attachment>` summary; the actual bytes ride in the JSON.
- **Verdict:** **Different design philosophies.** v1 (file-on-disk + path reference) is friendlier for big files and lets the agent feed paths to other tools (vision, ffmpeg, etc.) without re-encoding. v2 (base64-in-row) keeps everything addressable from the DB but doesn't scale to large media well. For agent vision workflows v1 is cleaner. **Verdict: KEEP** v1's file-on-disk + path approach. The pattern is genuinely better for media-heavy use cases. Confidence: medium — depends on v2's plans to grow large-media handling; arguably this is a CONTRIBUTE candidate but the architectural mismatch (no central per-group media dir in v2's session model) makes the contribution non-trivial.

#### Message splitting for platform limits

- **Functionality:** Split long agent replies on platform limits (Discord 2000, Telegram 4096) without mid-sentence truncation.
- **v1 approach:** Per-channel and ad-hoc. Telegram template hard-cuts at 4096 in a `for` loop (`add-channel-telegram/files/index.js:226-231`); WA template doesn't split (Baileys' own limit is high enough that it rarely matters).
- **v2 approach:** `splitForLimit(text, limit)` in `chat-sdk-bridge.ts:104-118` — paragraph → line → space → hard-cut, applied uniformly when `maxTextLength` is set on the bridge config. Reply id is the first chunk's id so subsequent edits/reactions still target the head.
- **Verdict:** v2's `splitForLimit` is a small, isolated utility. **Verdict: ADOPT** — port the function (12 lines) into v1's router or a shared helper, replace the Telegram template's hard-cut. Effort: trivial. Confidence: high.

### Verdict matrix

| Item | Action | Effort | Confidence | Depends on | Notes |
|------|--------|--------|------------|------------|-------|
| `ChannelAdapter` interface (whole) | SKIP-ARCH | large | high | Area 1 (entity model) | v2's shape only pays off with messaging_groups + sessions + two-DB delivery; not portable as a unit |
| `Channel` interface (v1 — keep as-is) | KEEP | — | high | — | Still suits v1's monolith; well-documented in `docs/CHANNEL_PLUGINS.md` |
| `registerChannelAdapter` self-register barrel | SKIP-ARCH | small | medium | Area 5 (extension/discovery) | Equivalent to v1's plugin discovery; choosing one over the other is part of Area 5's verdict |
| Chat SDK bridge (`chat-sdk-bridge.ts`) | SKIP-ARCH | large | high | vendor: `@chat-adapter/*`, `chat` lib | Non-trivial vendor footprint; bridge makes sense only if those packages are adopted wholesale |
| `splitForLimit` long-message splitter | ADOPT | trivial | high | — | 12-line pure function (`chat-sdk-bridge.ts:104-118`); replaces Telegram template's hard-cut |
| Per-channel `transformOutboundText` hook | ADOPT | trivial | medium | — | Useful pattern; v1 currently sanitizes inline. Net win small but nonzero |
| Per-channel `extractReplyContext` hook | ADOPT | trivial | medium | — | Cleans up inline reply parsing in WA channel |
| Telegram typed-media routing (`sendPhoto` / `sendVideo` / `sendAudio` by extension) | ADOPT | small | high | — | Port `channels/telegram.ts:25-116` into v1's Telegram template; closes a v1 gap (template has no `sendFile`) |
| Magic-bytes MIME detection | SKIP | — | high | — | Not present in either codebase. Spec's flag was a misremembering — actual v1 work was ffmpeg thumbnails |
| ffmpeg thumbnail extraction (videos + GIFs) | KEEP | — | high | — | v1-only feature in WA template (`/tmp/v1-wa-index.js:397-428`); v2 has no equivalent. Important for agent vision |
| ffmpeg thumbnail extraction (upstream contribution) | CONTRIBUTE | medium | medium | upstream's bridge attachment hook | Worth proposing as a post-`messageToInbound` hook in v2's bridge; chat-adapter platform variance complicates a single PR |
| Inbound media: file-on-disk + path reference | KEEP | — | high | — | v1's `mediaPath`/`mediaHostPath` model scales to large media; v2's base64-inline doesn't |
| File-on-disk media model (upstream contribution) | CONTRIBUTE | large | low | Area 1 (per-group dirs) | Architectural mismatch with v2's per-session storage; non-trivial PR |
| Reactions (interface) | KEEP | — | high | — | v1 has `react?(jid, messageId, emoji, participant?, fromMe?)`; v2 had a composite-id bug (commit `5e93609`) that doesn't exist in v1 because v1 doesn't suffix message ids per-agent |
| Composite-id reaction fix (`5e93609`) | SKIP | — | high | — | Bug only exists in v2 due to per-agent fan-out; nothing to port |
| `supportsThreads` adapter flag | SKIP-ARCH | small | high | Area 1 (sessions per thread) | Useful concept but only meaningful with v2's session-per-thread router logic |
| `subscribe(platformId, threadId)` | SKIP-ARCH | small | high | mention-sticky engage mode | Part of v2's engage modes; v1 has no thread model |
| `openDM(userHandle)` | SKIP-ARCH | small | high | Area 2 (approvals, user_dms) | Only matters with cold-DM scenarios v1 doesn't drive |
| CLI always-on local-socket channel | ADOPT | medium | medium | — | Basic socket loop is portable as a v1 channel plugin; admin-transport (`replyTo`) is v2-bound |
| Admin-transport (`onInboundEvent` + `replyTo`) | SKIP-ARCH | medium | high | router `replyTo` propagation | Requires router-level support v1 doesn't have |
| Telegram pairing flow + interceptor | ADOPT | medium | medium | v1 setup flow integration | Solves a real security gap (BotFather token = no user binding); needs surface for the operator to type the code |
| Telegram legacy-Markdown sanitizer | SKIP | — | high | — | Workaround for v2-only chat-adapter dependency |
| Sender-name override on outbound (sub-agent identity) | KEEP | — | high | — | v1's `sendMessage(jid, text, sender?, replyTo?)` carries this; v2 has no equivalent (sub-agent identity goes via `assistantName` system prompt) |
| Sender-override / Telegram swarm pool (upstream contribution) | CONTRIBUTE | medium | low | — | v1-only feature for distinct bot identities per sub-agent; cool but niche |
| `NetworkError` setup retry (`channel-registry.ts:10-94`) | ADOPT | trivial | high | — | 50-line retry wrapper with `[2,5,10]s` backoff; v1's `connect()` reconnects within the channel only, not at registration |
| `replyTo` reply-quote on outbound `sendMessage` | KEEP | — | high | — | v1 already has it (`src/types.ts:99`); v2's bridge does not surface it on the deliver path (only on inbound) — v1 wins |

### What surprised me

1. **The "magic-bytes MIME detection" in the spec doesn't exist in either codebase.** Both v1 and v2 use extension-based MIME inference. Danny's actual relevant work was the ffmpeg thumbnail extraction in commit `90955d9`, which is a different concern (rendering, not MIME). The verdict is empty for "magic-bytes" as written. If the desire is real magic-byte sniffing (e.g., via `file-type`), it's greenfield in either codebase.

2. **v2's reaction composite-id bug doesn't exist in v1 — but only because v1 doesn't have the underlying feature that caused it.** v2's `messageIdForAgent` (`router.ts:464-467`) suffixes inbound row ids with `:<agentGroupId>` to make per-agent fan-out work; v1 has no fan-out (one channel → one message processor) so the row id is just the platform id. The fix in `5e93609` is correct for v2 and irrelevant to v1.

3. **v1's Telegram channel template never had `sendFile`.** All the file-routing MIME-dispatch logic in v1 is WhatsApp-only (`/tmp/v1-wa-index.js:349-369`); the Telegram template at `add-channel-telegram/files/index.js` ships only `sendMessage`, `react`, `connect`, `disconnect`, `isConnected`, `ownsJid`. Agents trying to `send_file` to a Telegram chat in v1 silently fail at `routeOutboundFile`. v2's `channels/telegram.ts:25-116` typed-media routing closes that gap and is the cleanest single piece worth porting.

4. **v2's inbound-media model (base64-in-DB) is structurally weaker than v1's (file-on-disk + path).** Looks like a regression for media-heavy workflows — v1's path-based references let the agent shell out to ffmpeg/vision/`sips` directly without re-encoding. v2 has no per-group media directory because the storage model is per-session, not per-group.

### Cross-cutting concerns

- **Area 1 (DB schemas):** v2's `(channel_type, platform_id, thread_id)` triple addresses every messaging_groups row; v1's single `chat_jid` string is the address. Porting v2's adapter ergonomics requires the triple to land in v1's `registered_groups` first.
- **Area 2 (permissions/approvals):** `openDM`, the channel-request gate (`router.ts:111-130`), and the sender-resolver / access-gate hooks are all coupled to the `user_roles` + `agent_group_members` model. None of them port without that.
- **Area 3 (lifecycle/scheduling):** v2's outbound delivery polls `outbound.db` and applies the `agent_destinations` ACL at delivery (`delivery.ts:289-311`); v1 has no equivalent permission check at outbound time (auth is per-IPC-source, `src/ipc/auth.ts`). The two models can't be reconciled without rewriting the ACL.
- **Area 5 (extension system):** v1 channels are loaded via the plugin loader (`channelPlugin: true` + `onChannel` factory). v2 channels self-register via barrel imports + skill-installed branches. The interface differences in this area sit on top of that discovery split — each has its own verdict in Area 5; a coherent answer requires both areas' verdicts to land together.
- **Area 6 (ops/secrets):** Secrets redaction wraps both deliver paths (`delivery.ts:361` in v2, `router.ts:77` in v1); this is shared infra, already known to be a port match. CJK font support is an image-build concern out of scope here.

### Open questions

1. **CLI channel for v1:** Worth porting the basic socket loop as a v1 channel plugin? It's medium-effort but immediately useful for testing/debug; the question is whether v1's plugin model makes the file-IPC vs. socket impedance painful. Confidence on the verdict: medium.
2. **Telegram pairing flow:** Should this land in v1, given v1 has no first-class `user_roles` table to promote-to-owner against? The chat-attestation half is portable; the user-promotion half needs a place to live. Confidence: medium.
3. **ffmpeg thumbnail upstream contribution:** Is upstream interested in a bridge-level attachment-transform hook? Different chat-adapter platforms expose video buffers differently (Telegram via `att.fetchData()` returns the raw mp4; iMessage hands you a path). A single PR may need to be N PRs. Confidence: medium — needs a 30-minute conversation with the upstream maintainer before opening.
4. **`splitForLimit` placement in v1:** Should it go in `src/router.ts` (called from `routeOutbound`) or stay as a per-channel utility? Trade-off: router-level forces every channel to declare a `maxTextLength`, channel-level keeps it opt-in. Confidence: high on the port itself, low on placement.
5. **The v2 inbound-media regression:** Is this actually intentional in v2 (e.g., to avoid host-side filesystem coupling for the per-session container model), or accidental? If intentional, the file-on-disk approach can't be CONTRIBUTE'd cleanly — they made an architectural choice and base64-in-DB is the result. Worth a clarifying upstream issue before drafting the PR.

Counts: PORT=0, KEEP=6, ADOPT=7, SKIP-ARCH=7, SKIP=3, CONTRIBUTE=3 (total verdict rows: 26).
