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

Use the typed NanoTars CLI for group inspection. Do not query the entity-model SQLite tables directly from this skill.

## List Groups

```bash
nanotars groups list
```

For structured output:

```bash
nanotars groups list --json
```

## View A Group

```bash
nanotars groups show <folder>
```

This reports the group row, chat wirings, scheduled tasks, and installed subagents.

## Register A New Chat To A Group

For a new regular chat, prefer `/nanotars-add-group` because it walks the operator through naming, channel choice, and setup.

For the low-level pairing primitive:

```bash
nanotars groups register-code <folder>
```

The CLI prints a 4-digit code. Send that code from the chat that should be wired to the group.

For the main control chat, use:

```bash
nanotars pair-main [--channel <name>]
```

## Delete Or Migrate Groups

`nanotars groups delete` is intentionally not mutating yet. Use the existing chat admin `/delete-group <folder>` command for deletion until the TS CLI has a transactional dry-run/apply implementation.

Group-to-channel migration is not shipped yet. Do not migrate by editing database rows manually. Track this under the binary-first migrate-channel work.

## Related Commands

```bash
nanotars channels list
nanotars users list --group <folder>
nanotars tasks list --group <folder>
```

Use these to explain the complete state around a group without reaching into raw schema internals.
