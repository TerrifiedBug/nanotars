---
name: nanoclaw-remove-plugin
description: Use when removing, uninstalling, or deleting a NanoClaw plugin. Handles runtime plugin cleanup, env var removal, database cleanup for channels, container rebuild if needed, and marketplace skill uninstall.
---

# Remove Plugin

Fully removes a NanoClaw plugin — both the runtime plugin from `plugins/` and the marketplace installer skill if present.

## Step 1: Identify the Plugin

If the user provided a name, resolve it:
- Check `plugins/{name}/plugin.json` for skill plugins
- Check `plugins/channels/{name}/plugin.json` for channel plugins
- If neither exists, list all installed plugins and ask which one to remove:

```bash
echo "=== Skill Plugins ===" && ls -d plugins/*/plugin.json 2>/dev/null | sed 's|plugins/||;s|/plugin.json||'
echo "=== Channel Plugins ===" && ls -d plugins/channels/*/plugin.json 2>/dev/null | sed 's|plugins/channels/||;s|/plugin.json||'
```

## Step 2: Read the Manifest

Read the plugin's `plugin.json` to understand what needs cleaning up:

```bash
cat plugins/{name}/plugin.json        # skill plugin
cat plugins/channels/{name}/plugin.json  # channel plugin
```

Note these fields for cleanup:
- `containerEnvVars` — env vars to remove from `.env` and `groups/*/.env`
- `containerMounts` — host data directories (warn user, don't auto-delete)
- `dependencies` — whether it has its own `node_modules`

Check for a `Dockerfile.partial`:
```bash
[ -f plugins/{name}/Dockerfile.partial ] && echo "HAS_DOCKERFILE_PARTIAL" || echo "NO_DOCKERFILE_PARTIAL"
```

## Step 3: Show Removal Plan

Present what will happen using `AskUserQuestion` for confirmation:

**Always include:**
- Plugin directory to be deleted
- Env vars to be removed (list them by name)

**If applicable, also include:**
- `containerMounts` host paths that will be **preserved** (warn: "Data in `{hostPath}` will NOT be deleted — remove manually if not needed by other plugins")
- Channel-specific: group registrations and scheduled tasks to be cleaned from the database
- Dockerfile.partial: container image will need rebuilding

**Ask:** "Remove plugin `{name}`? This will delete the plugin directory and clean up env vars. NanoClaw will be rebuilt and restarted."

If the user declines, stop.

## Step 4: Stop NanoClaw

For channel plugins, NanoClaw must be stopped first. For skill plugins it's not strictly required but keeps things clean:

```bash
# Linux
sudo systemctl stop nanoclaw 2>/dev/null

# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null
```

## Step 5: Channel-Specific Database Cleanup

**Skip this step for skill plugins.**

For channel plugins, clean up database entries before removing the directory:

```bash
# Cancel scheduled tasks targeting groups on this channel
sqlite3 store/messages.db "UPDATE scheduled_tasks SET status = 'completed' WHERE chat_jid IN (SELECT jid FROM registered_groups WHERE channel = '{name}');"

# Remove group registrations for this channel
sqlite3 store/messages.db "DELETE FROM registered_groups WHERE channel = '{name}';"
```

Note: Group folders in `groups/` are preserved. Tell the user they can delete them manually if not needed.

## Step 6: Remove Plugin Directory

```bash
# Skill plugin
rm -rf plugins/{name}/

# Channel plugin
rm -rf plugins/channels/{name}/
```

## Step 7: Clean Environment Variables

For each var in `containerEnvVars`, remove from `.env` and all per-group `.env` files:

```bash
# Remove from global .env
sed -i '/^VAR_NAME=/d' .env

# Remove from per-group .env files
for f in groups/*/.env; do
  [ -f "$f" ] && sed -i '/^VAR_NAME=/d' "$f"
done
```

Only remove vars that are **exclusive to this plugin**. If a var is shared with another plugin (e.g., `GOG_KEYRING_PASSWORD` used by both `calendar` and `gmail`), check if the other plugin is still installed before removing:

```bash
# Check if any other installed plugin uses this var
grep -rl '"VAR_NAME"' plugins/*/plugin.json plugins/channels/*/plugin.json 2>/dev/null
```

If other plugins use the same var, skip it and tell the user.

## Step 8: Rebuild

```bash
npm run build
```

If the plugin had a `Dockerfile.partial`, also rebuild the container image:

```bash
./container/build.sh
```

## Step 9: Restart NanoClaw

```bash
# Linux
sudo systemctl start nanoclaw

# macOS
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Step 10: Marketplace Cleanup

Check if the corresponding marketplace installer skill is still available and inform the user:

> "The runtime plugin has been removed. If you installed this via the marketplace (`/plugin install nanoclaw-{name}@nanoclaw-skills`), the installer skill is still in your Claude Code plugin cache. You can remove it with: `/plugin uninstall nanoclaw-{name}`"
>
> "This is optional — the installer does nothing without the runtime plugin, but removing it keeps your skill list clean."
