---
name: nanotars-migrate-channel
description: Move an existing NanoTars group folder from one channel plugin to another using the binary-first migrate-channel CLI flow.
triggers:
  - migrate channel
  - move group to telegram
  - move group to whatsapp
  - switch group channel
  - migrate group
---

# Migrate Group Channel

Use the typed NanoTars CLI. Do not edit SQLite rows, plugin manifests, or `.env` files by hand from this skill.

This skill is only for moving one existing group folder to a different channel plugin. It is not for merging one group folder into another group folder, and it does not migrate message history.

## Inspect

```bash
nanotars groups list
nanotars channels list
nanotars plugins list
```

Confirm:

- the source group folder exists
- the source channel has an existing wiring for that group
- the destination channel plugin is installed and authenticated

If destination auth is missing:

```bash
nanotars channels auth <destination-channel>
```

## Preview

```bash
nanotars migrate-channel <folder> --from-channel <source> --to-channel <destination>
```

The preview reports the old chat bindings, scheduled tasks that will move, stale approval/DM rows that will be cleaned up, and plugin channel scopes that can be safely rewritten when the migration is claimed.

## Apply

```bash
nanotars migrate-channel <folder> --from-channel <source> --to-channel <destination> --apply
```

The CLI writes a database backup and prints a 4-digit migration pairing code. Send that code as a message from the destination channel chat.

When claimed, NanoTars:

- wires the existing group folder to the destination chat
- moves scheduled tasks from the old chat id to the destination chat id
- removes the old source-channel binding
- cleans stale approvals, pending questions, and old-channel DM bindings
- rewrites safe single-group plugin channel scopes from source to destination

Plugin scopes that cover multiple groups are reported for manual review because one manifest cannot express different channels per group.

## Verify

```bash
nanotars groups show <folder>
nanotars tasks list --group <folder>
nanotars plugins list
nanotars logs errors
```

Restart after the migration is claimed so plugin scope changes and channel routing are loaded by the running host:

```bash
nanotars restart
```
