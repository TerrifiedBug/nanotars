# nanotars catch-up backlog

Outstanding items from the upstream catch-up. See `docs/upstream-triage-2026-04-25.md` for the full 154-row verdict matrix and rationale; this doc only tracks what is **not yet shipped**.

Markers:
- `[ ]` outstanding, not started
- `[~]` partially shipped (scaffolded, needs finishing)
- `[?]` unverified — needs a code check before being acted on
- `[x]` done (kept here briefly so the previous turn's "outstanding" list can be reconciled)

When an item lands, strike it through or delete the line. The triage doc keeps the durable record.

---

## Phase 1 — trivial wins

All Phase 1 items shipped. See the Reconciliation section at the bottom of this doc for callsites and verification dates.

## Phase 2 — medium architecture-preserving

**Cluster A — migration framework / DB shape**
- [ ] `chat_sdk_*` SqliteStateAdapter as a generic KV + TTL + lock primitive (Area 1, ADOPT medium).
- [ ] Per-provider `session_state` continuation namespacing (Area 1, PORT trivial). Provider seam is in (`container/agent-runner/src/providers/`) but session_state isn't keyed per provider.

**Cluster B — compose pipeline**
- [~] Three-tier container skills — shared `container/skills/` + per-group `groups/<folder>/skills/` + selection list in `container.json`. Shared tier exists (`container/skills/agent-browser`, `container/skills/self-customize`); per-group tier and selection mechanism not yet present.

**Cluster C — channels & media**
- [ ] Telegram typed-media routing (`sendPhoto` / `sendVideo` / `sendAudio` extension-dispatch) — closes the `sendFile` gap. Not present in `plugins/channels/telegram/index.js`.
- [ ] CLI always-on local-socket channel (Area 4, ADOPT medium).

**Cluster E — secret redaction**
- [?] Verify nanotars's `src/secret-redact.ts` matches v2's body (length-sort, Set-dedup, injectable paths, `ONECLI_API_KEY` exempt). Module exists; body parity not checked.

## Phase 4 — multi-user RBAC + entity model

Migrations 008-018 are in (`agent_groups`, `messaging_groups`, `messaging_group_agents`, `users`, `user_roles`, `agent_group_members`, `user_dms`, `pending_approvals`, `pending_sender_approvals`, `pending_channel_approvals`, `pending_questions`). Approval primitive (`pickApprover`, `registerApprovalHandler`) and `pending-questions` accessors are in. The remaining work is finish-and-verify, not new design.

- [?] 4A finish — sender-resolver + access-gate hook callsites wired through router/orchestrator path (orchestrator references `agent_group_*` rows but the explicit hook surface needs an audit).
- [?] 4B finish — `command-gate.ts` host-side command gate against `user_roles`. Not yet found in `src/`.
- [?] 4C finish — card-expiry timer + edit-to-Expired sweep on startup. `index.ts:136` references the expiry sweep — confirm it covers `pending_sender_approvals` and `pending_channel_approvals` too.
- [?] 4C finish — OneCLI manual-approval bridge port. OneCLI gateway is in but the approval-bridge handler that uses `pickApprover` needs verification.
- [?] 4D finish — `pending_sender_approvals` and `pending_channel_approvals` request/respond flows. Tables exist; verify the orchestrator + plugin-side wiring is complete and end-to-end tested.

## Phase 5 — capability bolt-ons

Migrations + scaffolding are in: `install_packages` and `add_mcp_server` MCP tools, host-side validation/approval queueing, `applyDecision` handlers, `notifyAgent`, lifecycle pause/resume (`emergency_stop` + `resume_processing` in `src/lifecycle-handlers.ts`), per-agent-group image build (`src/image-build.ts`), `create_agent` permissions stub (`src/permissions/create-agent.ts`), AgentProvider seam (`container/agent-runner/src/providers/`).

- [?] 5A self-mod — end-to-end smoke test (request → approve → image rebuild → container restart with new package available). Pieces exist; confirm the full flow runs.
- [?] 5B finish — verify `image-build.ts` is invoked from the live install_packages path (not just available).
- [?] 5C `create_agent` MCP tool — permissions stub exists; confirm tool is registered and wired through approval primitive.
- [ ] 5D provider plugins — Codex / OpenCode / Ollama as plugins (not skill-branches). Provider seam is in; plugin manifests not.

## Phase 6 + 7 — architectural foundation (OPTIONAL)

Per the triage doc, this is the only fully-optional block. Per-session containers + two-DB IPC + heartbeat sweep + Phase-6-enabled bolt-ons (cross-container agent messaging, supportsThreads, subscribe, admin-transport, per-provider session_state).

- [ ] Decision needed: commit to Phase 6 or formally close it as "skipped under technical-merit lens." If skipped, Phase 7 items roll into "won't fix" since they require Phase 6 to land.

## Plugin & marketplace ecosystem

nanotars's plugin model lives across two repos: this fork (`TerrifiedBug/nanotars`) ships only core + a few baseline skills; everything else (channels, integrations) lives in the marketplace at `TerrifiedBug/nanotars-skills` and is installed via the Claude Code plugin marketplace. Catch-up work that touches the entity-model schema, the channel plugin interface, or the plugin boundary rules has marketplace-side consequences that the triage doc didn't track.

**Marketplace schema-staleness sweep (mirrors the local skills sweep):**
- [ ] Grep `TerrifiedBug/nanotars-skills` for `registered_groups` references across all `plugins/*/skills/**` and `plugins/*/files/container-skills/**`. ~25-30 plugins to scan.
- [ ] Per stale plugin, file a PR with the same `agent_groups ⋈ messaging_group_agents ⋈ messaging_groups` rewrite the local sweep uses. Reuse the rewritten `nanotars-groups` SKILL.md as the reference template.
- [ ] Decide on a min-nanotars-version contract for marketplace plugins. Currently nothing in `plugin.json` declares "this plugin requires nanotars ≥ migration 018." Without it, an old marketplace plugin installed on a current nanotars (or a current marketplace plugin installed on a stale nanotars) silently breaks. Either a `compatibleNanotarsVersion` field on `plugin.json` checked at install time, or a CI bot in `nanotars-skills` that flags `registered_groups` references on PRs.

**In-container skill-creation flow correctness:**
- [ ] When a user in a Telegram chat asks TARS to build a skill, in-container TARS has no `/create-skill-plugin` skill and no formal plugin-boundary rulebook — those are host-side artifacts (`.claude/skills/create-skill-plugin/`, `.claude/skills/nanotars-publish-skill/`, the `Plugin Boundary` section of `CLAUDE.md`). Build a container-side equivalent so in-chat skill creation produces marketplace-compliant output instead of improvising from filesystem inspection.
- [ ] Decide on the artifact: (a) a bundled `container/skills/create-skill-plugin/` that mirrors the host skill, (b) a `groups/global/IDENTITY.md` snippet that points TARS at the host skill via a request-handoff, or (c) a structured rule doc (e.g. `container/skills/plugin-rules.md`) that defines the boundary inline so any agent can follow it without a skill invocation. Recommendation: (c) for the rules + (a) for the guided flow.
- [ ] End-to-end test: from a Telegram message ("TARS, make me a skill that does X") through to a PR opened on `TerrifiedBug/nanotars-skills`. Validates that in-container TARS knows to invoke the right skill, generates to `.claude/skills/add-skill-*/`, uses `Dockerfile.partial` (never core `Dockerfile`), and either invokes a publish primitive itself or surfaces a clear "ready to publish — run `/nanotars-publish-skill` on the host" handoff.
- [ ] In-container `gh` availability + auth surface for the publish step. If TARS is meant to open PRs autonomously from the container, the `gh` CLI needs to be present and authenticated with marketplace-PR permissions. If publishing stays a host-only step, the container path needs to stop short cleanly with a handoff message.
- [ ] Periodic accuracy re-check of host `create-skill-plugin` and `nanotars-publish-skill` SKILLs against the live plugin model. Both verified accurate 2026-04-27 (last touched 2026-04-26 in `0fe1962`), but they drift whenever the plugin interface evolves (new `plugin.json` fields, new container-skill mount paths, new marketplace layout). Wire this re-check into the catch-up workflow: any commit touching `src/plugin-loader.ts`, `src/plugin-types.ts`, `src/container-mounts.ts`, or marketplace conventions should trigger a manual review of these two SKILLs.

## Native `/commands` feature (Hermes parity)

Currently `src/command-gate.ts` has a hardcoded admin-only command Set (`/grant`, `/revoke`, `/list-users`, `/list-roles`, `/register-group`, `/delete-group`, `/restart`, `/pause`, `/resume`, `/rebuild-image`, `/pair-telegram`). Each command has its own bespoke handler module (`src/lifecycle-admin-commands.ts`, `src/pair-admin-command.ts`, `src/rebuild-image-admin-command.ts`). Non-admin commands have no formal dispatcher — they fall through to the agent which interprets raw text. There is no plugin-extensible command registration. Goal: a Hermes-style generic command framework.

- [ ] Centralised host-side command dispatcher — extract the per-command handler dispatch from the bespoke modules into a single registry keyed by command name. Each entry: `{ name, adminOnly, handler, helpText, argSpec? }`.
- [ ] Plugin-extensible registration — extend `ChannelPluginConfig` (or add a top-level `plugin.commands` field) so plugins can register their own commands with the dispatcher. Reuses the existing `command-gate.ts` admin/non-admin gating.
- [ ] Built-in `/help` — auto-generated from registered commands' `helpText`. Replaces ad-hoc help-string improvisation by the agent.
- [ ] Telegram-side native UI — call BotFather's `setMyCommands` API on plugin load so commands appear in the Telegram client's `/` autocomplete menu. Per-chat-scope override available for admin-only commands.
- [ ] Argument parsing primitive — minimal `argSpec` (positional + named) so commands like `/foo bar=baz` get pre-parsed before reaching the handler. Avoid pulling in a full CLI parser; aim for ~50 LOC.
- [ ] Cross-channel parity — same registration model works on whatever non-Telegram channels are installed (Discord, Slack, etc.). Each channel plugin maps its native command surface (slash-commands, reactions, mentions) to the dispatcher's expectations.
- [ ] Migration of the existing 11 admin commands onto the new dispatcher — mechanical port; do this as the second-to-last step so the new dispatcher gets exercised before the old paths are torn out.
- [ ] Decision needed: should agents be able to register commands too (e.g. an in-container agent declares "I respond to `/myskill`")? Probably yes for skill plugins, but the security implication (agent registers `/grant` and shadows the admin command) needs `command-gate.ts` to enforce a reserved-name list.

## Side debt — schema-stale skills sweep (local)

Skills still query the dropped `registered_groups` schema (migration 009). `nanotars-groups` was rewritten 2026-04-26. Remaining:

- [ ] `.claude/skills/nanotars-add-agent/SKILL.md`
- [ ] `.claude/skills/nanotars-debug/SKILL.md`
- [ ] `.claude/skills/create-channel-plugin/SKILL.md`
- [ ] `.claude/skills/nanotars-remove-plugin/SKILL.md`
- [ ] `.claude/skills/nanotars-setup/SKILL.md`
- [ ] `.claude/skills/nanotars-add-group/SKILL.md`

Each should switch to the three-table join (`agent_groups` ⋈ `messaging_group_agents` ⋈ `messaging_groups`) and target modern wiring fields (`engage_mode` / `engage_pattern` / `sender_scope` / `ignored_message_policy`) instead of `requires_trigger`.

(See "Plugin & marketplace ecosystem" above for the marketplace-side mirror of this sweep.)

## CONTRIBUTE upstream — opt-in goodwill PRs

These are nanotars wins missing in v2. Pure upside for upstream; no effect on this fork.

- [ ] Container hardening flags PR (`--cap-drop=ALL`, `--cap-add=SYS_PTRACE`, `--security-opt=no-new-privileges`, custom seccomp, `--cpus=2`, `--memory=4g`, `--pids-limit=256`). Single-block PR — biggest concrete security delta in the triage.
- [ ] `AUTH_ERROR_PATTERNS` + `isAuthError` PR (`src/router.ts:7`).
- [ ] `MAX_CONCURRENT_CONTAINERS` host-wide cap PR — v2 still exports the constant but never reads it; ~30 LOC semaphore-around-`wakeContainer`.
- [ ] Mount allowlist tests PR (`src/__tests__/mount-security.test.ts` portable; v2 ships zero tests for security-critical code).
- [ ] ffmpeg thumbnail extraction for inbound video/GIF PR (Area 4 UX win).
- [ ] `isValidGroupFolder` defense-in-depth on read path PR (Area 1).
- [ ] `context_mode` ('group' | 'isolated') on `scheduled_tasks` PR.
- [ ] Online backup hook (`db.backup` keep-2 retention) PR.
- [ ] `task_run_logs` table + recent-runs view PR.

## Reconciliation — items reported "outstanding" 2026-04-27 that turned out to be shipped

(Kept here briefly so memory observation 9286-9315 reconcile cleanly. Delete after first read.)

- [x] Mount allowlist colon-injection check — `src/mount-security.ts:213`.
- [x] `splitForLimit` + tests — `src/channel-helpers.ts:11`, `src/__tests__/channel-helpers.test.ts`.
- [x] `transformOutboundText` / `extractReplyContext` / `NetworkError` retry / `openDM` — all in `src/types.ts` + `src/router.ts` + `src/plugin-loader.ts` + `src/permissions/user-dms.ts`.
- [x] `unregistered_senders` table — `src/db/init.ts:272`.
- [x] `isValidGroupFolder` defense-in-depth — used in `src/task-scheduler.ts:68` and `src/permissions/create-agent.ts:35`.
- [x] `hasTable` helper — `src/db/init.ts:304`.
- [x] Numbered migration framework with `schema_version.name` — `src/db/init.ts:609-680` (18 migrations applied).
- [x] Pinned `CLAUDE_CODE_VERSION` ARGs + `tini` PID 1 + `minimumReleaseAge=4320` — all in `container/Dockerfile` and `container/agent-runner/.npmrc`.
- [x] `manage-mounts` skill port — `.claude/skills/manage-mounts`.
- [x] `context_mode` on scheduled_tasks + online backup hook + `task_run_logs` table — `src/db/init.ts`.
- [x] `secret-redact` module — `src/secret-redact.ts` (parity with v2's body still flagged `[?]` above).
- [x] `claude-md-compose.ts` + `CLAUDE.local.md` — `src/claude-md-compose.ts`.
- [x] Vitest + GH Actions CI — `vitest.config.ts`, `.github/workflows/ci.yml`.
- [x] Four-axis engage model — `src/db/init.ts:40-43` + migration `007_add_engage_mode_axes`.
- [x] Label-scoped orphan cleanup — `src/container-runtime.ts:93,117` uses `--filter label=...`.
- [x] Pre-task `script` hook on scheduled_tasks — migration `006_add_task_script`.
- [x] Router refactor onto (messaging_group, agent_group) — `src/orchestrator.ts:194-340`.
- [x] Lifecycle pause/resume — `src/lifecycle-handlers.ts`.
- [x] Per-agent-group image build — `src/image-build.ts`.
- [x] AgentProvider seam — `container/agent-runner/src/providers/factory.ts`.
- [x] OneCLI gateway — Cluster F shipped 2026-04-25; latest commit walks back the user-facing surface ("Option A: de-emphasize OneCLI").
- [x] `dockerfilePartials` path-traversal guard — `src/image-build.ts:43-49` (TypeScript path) + `container/build.sh:24-34` (shared base build path). Both code paths that resolve+read partials guard with `path.relative` (TS) or `readlink -f` + case-pattern (bash). Verified 2026-04-27.
- [x] `READ_TOOLS_RE` expansion — `container/agent-runner/src/security-hooks.ts:62` regex includes every tool from the triage list (`more`, `od`, `hexdump`, `bun`, `awk`, `sed`, `python3`) plus `cat`, `less`, `head`, `tail`, `base64`, `xxd`, `strings`, `python`, `node`, `perl`, `ruby`. Tests at `security-hooks.test.ts:72,86` cover `hexdump` and `bun`. Verified 2026-04-27.
- [x] `shellQuote` unit tests — extracted into `src/container-mounts.ts` as `shellQuote(value)`; tests in `src/__tests__/shell-quote.test.ts` (5 cases). Slice 1 work, 2026-04-27.
