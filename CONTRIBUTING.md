# Contributing

There are three ways to contribute to NanoClaw.

## 1. Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be plugins or skills.

## 2. Skill Plugins

A skill plugin adds an integration (calendar, weather, search, home automation, etc.) that agents can use inside their containers. Skills are installed per-deployment — the `plugins/` directory is gitignored so each user's installation is different.

Skills live in the [nanoclaw-skills marketplace](https://github.com/TerrifiedBug/nanoclaw-skills). The main repo contains only core skills (`nanoclaw-*`) and creation tools (`create-*-plugin`).

**How to contribute a skill plugin:**

1. Run `/create-skill-plugin` — it scaffolds everything: `plugin.json`, hook files, container skills, and an installation skill
2. Test it locally with the generated `/add-skill-{name}` command
3. Publish to the marketplace with `/nanoclaw-publish-skill {name}`

## 3. Channel Plugins

A channel plugin connects NanoClaw to a messaging platform (Telegram, Slack, SMS, etc.). Channel plugins implement the Channel interface defined in `src/plugin-types.ts`.

**How to contribute a channel plugin:**

1. Run `/create-channel-plugin` — it scaffolds the channel implementation and an installation skill
2. Test it locally with the generated `/add-channel-{name}` command
3. Publish to the marketplace with `/nanoclaw-publish-skill {name}`

## Plugin Structure

At runtime, every plugin lives in `plugins/` and has a `plugin.json` manifest. In the repo, the plugin template lives in `.claude/skills/add-{type}-{name}/files/` and gets copied to `plugins/` when the installation skill runs.

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
