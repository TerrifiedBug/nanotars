<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  My personal Claude assistant that runs securely in containers. Lightweight and built to be understood and customized for your own needs.
</p>

<p align="center">
  <a href="https://discord.gg/VGWXrf8x"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>
</p>

**New:** First AI assistant to support [Agent Swarms](https://code.claude.com/docs/en/agent-teams). Spin up teams of agents that collaborate in your chat.

## Why I Built This

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project with a great vision. But I can't sleep well running software I don't understand with access to my life. OpenClaw has 52+ modules, 8 config management files, 45+ dependencies, and abstractions for 15 channel providers. Security is application-level (allowlists, pairing codes) rather than OS isolation. Everything runs in one Node process with shared memory.

NanoClaw gives you the same core functionality in a codebase you can understand in 8 minutes. One process. A handful of files. Agents run in actual Linux containers with filesystem isolation, not behind permission checks.

## Quick Start

```bash
git clone https://github.com/qwibitai/nanoclaw.git
cd nanoclaw
claude
```

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup, service configuration.

## Philosophy

**Small enough to understand.** One process, a few source files. No microservices, no message queues, no abstraction layers. Have Claude Code walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker). They can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for your needs.** This isn't a framework. You fork it, install the channel and skill plugins you want, and end up with a clean system tailored to your exact needs.

**Customization = Claude Code skills.** The core stays untouched. Everything is installed via [Claude Code skills](https://code.claude.com/docs/en/skills) — run `/add-channel-telegram` to add Telegram, `/add-skill-weather` to add weather lookups. Skills teach Claude Code how to create and configure plugins on your fork. Browse `.claude/skills/` for what's available, or run `/create-skill-plugin` and `/create-channel-plugin` to build your own.

**AI-native.** No installation wizard; Claude Code guides setup. No monitoring dashboard; ask Claude what's happening. No debugging tools; describe the problem, Claude fixes it.

**Skills over features.** Contributors don't add features to the core. They contribute [Claude Code skills](https://code.claude.com/docs/en/skills) that create plugins. A skill is a markdown file that teaches Claude Code how to build and configure a plugin on your fork. You run it, Claude does the work, and you end up with clean code that does exactly what you need.

**Best harness, best model.** This runs on Claude Agent SDK, which means you're running Claude Code directly. The harness matters. A bad harness makes even smart models seem dumb, a good harness gives them superpowers. Claude Code is (IMO) the best harness available.

## What It Supports

- **Multi-channel messaging** - Connect via WhatsApp, Telegram, Discord, or build your own channel plugin (`/create-channel-plugin`)
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted
- **Main channel** - Your private channel (self-chat) for admin control; every other group is completely isolated
- **Plugin system** - Add integrations via Claude Code skills — calendar, weather, search, home automation, and more. Each skill creates and configures a plugin on your fork
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content
- **Container isolation** - Agents sandboxed in Apple Container (macOS) or Docker (macOS/Linux)
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks

## Usage

Talk to your assistant with the trigger word (default: `@TARS`):

```
@TARS send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@TARS review the git history for the past week each Friday and update the README if there's drift
@TARS every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@TARS list all scheduled tasks across groups
@TARS pause the Monday briefing task
@TARS join the Family Chat group
```

## Customizing

There are no configuration files to learn. Just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills that install plugins.**

Everything in NanoClaw is delivered as a Claude Code skill. Want to add Telegram support? Contribute a skill (`.claude/skills/add-channel-telegram/SKILL.md`) that teaches Claude Code how to create and configure a Telegram channel plugin. Want to add weather lookups? Contribute a skill that installs a weather skill plugin.

Users run the skill on their fork and get clean, working code tailored to their setup. See [CONTRIBUTING.md](CONTRIBUTING.md) for details on contributing skills, channel plugins, and skill plugins.

### RFS (Request for Skills)

Skills we'd love the community to build:

**Communication Channels**
- `/add-channel-slack` - Add Slack as a channel plugin
- `/add-channel-sms` - Add SMS via Twilio or similar

**Platform Support**
- `/setup-windows` - Windows via WSL2 + Docker

**Session Management**
- `/add-clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session). Requires figuring out how to trigger compaction programmatically via the Claude Agent SDK.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

### Optional

- **ffmpeg** — High-quality video/GIF thumbnail extraction for channel plugins. Without it, low-res previews from channel metadata are used.
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt install ffmpeg`

## Architecture

```
Channel Plugins --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
```

Single Node.js process. Channel plugins deliver messages; agents execute in isolated Linux containers with mounted directories. Per-group message queue with concurrency control. IPC via filesystem. Plugins are installed via Claude Code skills.

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/plugin-loader.ts` - Plugin discovery, loading, and registry
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/container-mounts.ts` - Volume mount construction, env files, secrets
- `src/container-runtime.ts` - Container runtime abstraction (Docker/Apple Container)
- `src/mount-security.ts` - Mount path validation and allowlist
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**How do I add a channel?**

Run a channel installation skill. For example, `/add-channel-telegram` or `/add-channel-discord`. Each skill guides you through setup, authentication, and group registration. To build a channel for a platform that doesn't have a skill yet, run `/create-channel-plugin`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize it to so that the code matches exactly what they want rather than configuring a generic system. If you like having config files, tell Claude to add them.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach.

**Why isn't the setup working for me?**

I don't know. Run `claude`, then run `/debug`. If claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Security fixes, bug fixes, and clear improvements to the base configuration. That's it.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VGWXrf8x).

## License

MIT
