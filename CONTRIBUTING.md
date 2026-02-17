# Contributing

There are three ways to contribute to NanoClaw.

## 1. Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be plugins or skills.

## 2. Skill Plugins

A skill plugin adds an integration (calendar, weather, search, home automation, etc.) that agents can use inside their containers. Skills are installed per-deployment — the `plugins/` directory is gitignored so each user's installation is different.

**How to contribute a skill plugin:**

1. Run `/create-skill-plugin` on a fresh clone to scaffold your plugin
2. Your plugin needs a `plugin.json` manifest defining hooks, `containerEnvVars`, and optional `Dockerfile.partial`
3. Create an installation skill in `.claude/skills/add-skill-{name}/SKILL.md` that guides users through setup
4. Test by running the installation skill on a fresh clone

A PR that contributes a skill plugin should include the installation skill in `.claude/skills/` and optionally the plugin code in `plugins/`. Since `plugins/` is gitignored, the installation skill is what actually gets distributed — it teaches Claude Code how to create and configure the plugin.

## 3. Channel Plugins

A channel plugin connects NanoClaw to a messaging platform (Telegram, Slack, SMS, etc.). Channel plugins implement the Channel interface defined in `src/plugin-types.ts`.

**How to contribute a channel plugin:**

1. Run `/create-channel-plugin` on a fresh clone to scaffold your plugin
2. Implement the Channel interface: `connect()`, `disconnect()`, message storage, authentication
3. Create an installation skill in `.claude/skills/add-channel-{name}/SKILL.md`
4. Test by running the installation skill on a fresh clone

See existing channel installation skills (e.g., `.claude/skills/add-channel-telegram/`, `.claude/skills/add-channel-discord/`) for reference.

## Plugin Structure

Every plugin lives in `plugins/` and has a `plugin.json` manifest:

```json
{
  "name": "my-plugin",
  "description": "What this plugin does",
  "containerEnvVars": ["MY_API_KEY"],
  "hooks": ["onStartup", "onShutdown"],
  "containerHooks": ["hooks/post-tool-use.js"],
  "channelPlugin": false,
  "dependencies": true
}
```

Key concepts:
- **`containerEnvVars`** — env var names from `.env` to inject into agent containers
- **`hooks`** — host-side lifecycle hooks (`onStartup`, `onShutdown`, `onInboundMessage`, `onChannel`)
- **`containerHooks`** — SDK hooks that run inside agent containers
- **`channelPlugin`** — `true` for channel plugins that provide messaging I/O
- **`dependencies`** — `true` if the plugin has its own `package.json`/`node_modules`
- **`Dockerfile.partial`** — extra build steps merged into the agent container image

For complete documentation, run `/create-skill-plugin` or `/create-channel-plugin`.

## Why Skills Over Features?

Every user should have clean, minimal code that does exactly what they need. Skills let users selectively add capabilities to their fork without inheriting code for features they don't want. The base repository stays small and understandable.

## Testing

Test your contribution by running it on a fresh clone before submitting. For plugins, verify:
- The installation skill runs to completion
- The plugin loads without errors (`plugin-loader.ts` discovers it)
- No hardcoded secrets (use `containerEnvVars` in `plugin.json`)
