---
name: manage-mounts
description: Configure which host directories nanotars agent containers can access. View, add, or remove mount allowlist entries. Triggers on "mounts", "mount allowlist", "agent access to directories", "container mounts".
---

# Manage Mounts

Use the typed NanoTars CLI. Do not hand-edit `~/.config/nanotars/mount-allowlist.json`.

The allowlist controls additional host directories that agent containers may mount. It lives outside the project root so agents cannot modify it from inside containers.

## Show Current Config

```bash
nanotars mounts list
```

## Add An Allowed Root

Ask for:

- host path
- read-only or read-write access; default to read-only
- optional description

Then run:

```bash
nanotars mounts add <path> [--rw] [--description "<text>"]
```

Examples:

```bash
nanotars mounts add ~/projects --description "Project checkouts"
nanotars mounts add /srv/shared --rw --description "Shared working data"
```

## Add A Blocked Pattern

```bash
nanotars mounts block <pattern>
```

## Remove Entries

Use the 1-based indexes shown by `nanotars mounts list`.

```bash
nanotars mounts remove <index>
nanotars mounts remove-block <index>
```

## Reset

```bash
nanotars mounts reset
```

This resets to the safest default: no additional host directories are allowed.

## After Changes

Mount-security is cached by the host process. Restart NanoTars so new containers pick up the config:

```bash
nanotars restart
```
