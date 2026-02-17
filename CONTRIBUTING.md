# Contributing

There are three ways to contribute to NanoClaw.

## 1. Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be plugins or skills.

## 2. Skill Plugins

A skill plugin adds an integration (calendar, weather, search, home automation, etc.) that agents can use inside their containers. Skills are installed per-deployment — the `plugins/` directory is gitignored so each user's installation is different.

**How to contribute a skill plugin:**

1. Run `/create-skill-plugin` on a fresh clone — it scaffolds everything: `plugin.json`, hook files, container skills, and an installation skill in `.claude/skills/add-skill-{name}/`
2. Test by running the generated installation skill on a fresh clone
3. Submit a PR containing the `.claude/skills/add-skill-{name}/` directory

The PR only contains the installation skill and its `files/` subdirectory (the plugin template). The `plugins/` directory is gitignored — when a user runs `/add-skill-{name}`, the skill copies the template files into `plugins/` on their fork.

## 3. Channel Plugins

A channel plugin connects NanoClaw to a messaging platform (Telegram, Slack, SMS, etc.). Channel plugins implement the Channel interface defined in `src/plugin-types.ts`.

**How to contribute a channel plugin:**

1. Run `/create-channel-plugin` on a fresh clone — it scaffolds the channel implementation and an installation skill in `.claude/skills/add-channel-{name}/`
2. Test by running the generated installation skill on a fresh clone
3. Submit a PR containing the `.claude/skills/add-channel-{name}/` directory

Same as skill plugins — the PR only contains the skill directory. The plugin code lives in `.claude/skills/add-channel-{name}/files/` and gets copied to `plugins/channels/{name}/` when a user runs the installation skill.

See existing channel skills (e.g., `.claude/skills/add-channel-telegram/`, `.claude/skills/add-channel-discord/`) for reference.

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
