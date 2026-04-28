---
name: nanotars-groups
description: List, view, and manage NanoTars group configurations
triggers:
  - list groups
  - show groups
  - manage groups
  - group config
  - group settings
  - edit group
  - update group
---

# Group Config Management

Inspect and manage NanoTars group registrations through the canonical operator surfaces (admin slash commands + filesystem). Do not query the SQLite schema directly — schema migrations move column shapes around silently and break inlined SQL.

The entity model splits group state across three tables (`agent_groups`, `messaging_groups`, `messaging_group_agents`). The slash commands below abstract that — use them.

## List groups

From your **main chat**, send:

```
/list-groups
```

The host handles this directly (it never reaches the agent — see `src/command-gate.ts`) and replies with each registered agent group and the chats wired to it.

Example output:

```
Registered groups:

  main
    channel: telegram   platform_id: -1001234567890   engage_mode: always
  research
    channel: whatsapp   platform_id: 120363336345536173@g.us   engage_mode: pattern
  ops
    (unwired)
```

Columns:

| Field | Meaning |
|-------|---------|
| `folder` | Directory under `groups/` — the agent group's identity |
| `channel` | `telegram`, `whatsapp`, `discord`, etc. — the platform the chat lives on |
| `platform_id` | Channel-native chat identifier (Telegram chat_id, WhatsApp JID, Discord channel ID) |
| `engage_mode` | One of the four engage axes (see Schema Reference below) |

An agent group with no wiring shows `(unwired)` — the folder exists but no chat routes messages to it yet.

## View a group's config

There's no slash command for per-group detail today; inspect the filesystem layer:

```bash
GROUP="{folder}"

ls -la groups/${GROUP}/
cat groups/${GROUP}/IDENTITY.md   2>/dev/null
cat groups/${GROUP}/CLAUDE.md     2>/dev/null
ls   groups/${GROUP}/agents/      2>/dev/null
du -sh groups/${GROUP}/
```

`IDENTITY.md` holds the agent group's persona/role. `CLAUDE.md` is the per-group memory the agent reads on every turn. `agents/` holds subagent definitions installed by `/nanotars-add-agent`.

For wiring details (engage_mode, platform_id, etc.) the `/list-groups` output is the source of truth — don't reach into the schema.

## Add a new group

Use `/nanotars-add-group` — it walks through the channel-specific chat discovery and registration. Don't duplicate that workflow here.

The underlying primitive (channel-agnostic) is:

```
/register-group <folder>
```

…sent from the **main chat**. The host emits a 4-digit pairing code; send that code from the new chat to claim the wiring.

`/pair-telegram` is a legacy alias for `/register-group main`.

## Delete a group

From the main chat:

```
/delete-group <folder>
```

This removes the entity-model rows (the agent group plus all of its wirings). The directory `groups/<folder>/` is **preserved on disk** so you can reinstate later by running `/register-group <folder>` again — the existing IDENTITY.md, CLAUDE.md, and agent definitions will be picked up on re-registration.

## Modify wiring (engage_mode, engage_pattern, sender_scope, ignored_message_policy)

**Not yet shipped.** Wiring-modification commands (`/set-engage-mode`, `/set-trigger`, `/set-scope`, `/set-ignored-policy`) aren't in the admin command set today — see backlog for the proposed addition.

Until then, the four engage axes default to sane values per channel and per group-type at registration time. If you need to change them, file a backlog item rather than reaching into the schema. Editing `messaging_group_agents` rows by hand bypasses validation and will drift out of sync the next time the schema changes.

## Schema Reference (background)

The four "engage axes" on each `messaging_group_agent` wiring describe **when** the agent wakes up for a given (chat, agent_group) pair. Useful background when filing backlog items or reading `/list-groups` output:

### `engage_mode`

| Value | Meaning |
|-------|---------|
| `always` | Every inbound message wakes the agent |
| `pattern` | Only messages matching `engage_pattern` wake the agent |
| `mention` | Only when the agent is @-mentioned (channel-defined) |
| `reply` | Only when a message is a reply to the agent's last message |

Default depends on channel + chat type (a 1:1 DM defaults to `always`; a busy group defaults to `pattern` or `mention`).

### `engage_pattern`

The string/regex consulted when `engage_mode = pattern`. Was called `trigger_pattern` pre-migration. Empty when `engage_mode != pattern`.

### `sender_scope`

| Value | Meaning |
|-------|---------|
| `all` | Anyone in the chat can engage the agent |
| `whitelist` | Only operator-listed senders engage |
| `admin_only` | Only operators with the `admin` role engage |

Combined with role grants (`/grant`, `/revoke`, `/list-users`).

### `ignored_message_policy`

| Value | Meaning |
|-------|---------|
| `drop` | Messages that don't engage are discarded |
| `log` | Recorded to history but not shown to the agent |
| `context` | Recorded **and** shown as context on the next engagement |

Determines what the agent sees in the rolling chat history when it does eventually wake up.
