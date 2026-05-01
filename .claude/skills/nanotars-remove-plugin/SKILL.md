---
name: nanotars-remove-plugin
description: Use when removing, uninstalling, or deleting a NanoTars plugin. Handles runtime plugin cleanup, env var removal, database cleanup for channels, container rebuild if needed, and marketplace skill uninstall.
---

# Remove Plugin

Use the typed NanoTars CLI. Do not remove plugin directories, edit `.env`, or clean channel database rows by hand from this skill.

## List Installed Plugins

```bash
nanotars plugins list
nanotars channels list
```

## Preview Removal

Skill plugin:

```bash
nanotars plugin remove <name>
```

Channel plugin:

```bash
nanotars channels remove <name>
```

The preview reports:

- plugin directory that would be removed
- exclusive env vars that would be removed from `.env` and group `.env` files
- shared env vars that will be preserved
- channel chats and scheduled tasks affected, for channel plugins
- whether the container image needs rebuilding because of `Dockerfile.partial`
- declared container mounts that are preserved on disk

## Apply Removal

Ask for explicit operator confirmation after showing the preview.

Skill plugin:

```bash
nanotars plugin remove <name> --apply
```

Channel plugin:

```bash
nanotars channels remove <name> --apply
```

The apply path backs up the SQLite database before channel cleanup, removes only exclusive env vars, deletes the runtime plugin directory, and leaves host data mounts untouched.

## Finish

After apply:

```bash
npm run build
nanotars restart
```

If the removed plugin had `Dockerfile.partial`, also rebuild the container image before restart:

```bash
./container/build.sh
nanotars restart
```

Marketplace installer cleanup remains optional. Tell the operator they can uninstall the installer plugin from Claude Code if they want to hide the `/add-*` skill from their skill list.
