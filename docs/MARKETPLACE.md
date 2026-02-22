# Skill Marketplace

NanoClaw's installable skills are distributed via the [nanoclaw-skills](https://github.com/TerrifiedBug/nanoclaw-skills) marketplace, a Claude Code plugin repository. This keeps the main NanoClaw repo focused on core functionality while making 27 integration and channel skills discoverable and installable through Claude Code's native plugin system.

## Quick Start

```bash
# Add the marketplace (one-time)
/plugin marketplace add TerrifiedBug/nanoclaw-skills

# Browse available skills
# Use the /plugin Discover tab

# Install a skill
/plugin install nanoclaw-weather@nanoclaw-skills

# Run the installed skill
/add-skill-weather
```

If you cloned a NanoClaw fork with `.claude/settings.json` configured, the marketplace is auto-discovered — no manual `marketplace add` needed.

## Available Skills

### Channels (4)

| Plugin | Skill Command | Description |
|--------|--------------|-------------|
| `nanoclaw-whatsapp` | `/add-channel-whatsapp` | WhatsApp via Baileys |
| `nanoclaw-discord` | `/add-channel-discord` | Discord bot |
| `nanoclaw-telegram` | `/add-channel-telegram` | Telegram bot |
| `nanoclaw-slack` | `/add-channel-slack` | Slack bot |

### Productivity (5)

| Plugin | Skill Command | Description |
|--------|--------------|-------------|
| `nanoclaw-calendar` | `/add-skill-calendar` | Google Calendar + CalDAV |
| `nanoclaw-notion` | `/add-skill-notion` | Notion API |
| `nanoclaw-gmail` | `/add-skill-gmail` | Gmail via gog CLI |
| `nanoclaw-imap-read` | `/add-skill-imap-read` | Read-only IMAP email |
| `nanoclaw-dashboard` | `/add-skill-dashboard` | Admin web UI |

### Search (2)

| Plugin | Skill Command | Description |
|--------|--------------|-------------|
| `nanoclaw-brave-search` | `/add-skill-brave-search` | Brave Search API |
| `nanoclaw-parallel` | `/add-skill-parallel` | Parallel AI web research |

### Media (2)

| Plugin | Skill Command | Description |
|--------|--------------|-------------|
| `nanoclaw-giphy` | `/add-skill-giphy` | GIF search via Giphy |
| `nanoclaw-transcription` | `/add-skill-transcription` | Voice transcription via Whisper |

### Monitoring & Automation (7)

| Plugin | Skill Command | Description |
|--------|--------------|-------------|
| `nanoclaw-freshrss` | `/add-skill-freshrss` | Self-hosted RSS reader |
| `nanoclaw-changedetection` | `/add-skill-changedetection` | Website change monitoring |
| `nanoclaw-webhook` | `/add-skill-webhook` | HTTP webhook endpoint |
| `nanoclaw-n8n` | `/add-skill-n8n` | n8n workflow automation |
| `nanoclaw-github` | `/add-skill-github` | GitHub API access |
| `nanoclaw-stocks` | `/add-skill-stocks` | Stock prices via Yahoo Finance |
| `nanoclaw-cs2-esports` | `/add-skill-cs2-esports` | CS2 esports match tracking |

### Smart Home (1)

| Plugin | Skill Command | Description |
|--------|--------------|-------------|
| `nanoclaw-homeassistant` | `/add-skill-homeassistant` | Home Assistant via MCP |

### Utilities (6)

| Plugin | Skill Command | Description |
|--------|--------------|-------------|
| `nanoclaw-weather` | `/add-skill-weather` | Weather via wttr.in |
| `nanoclaw-commute` | `/add-skill-commute` | Travel times via Waze |
| `nanoclaw-trains` | `/add-skill-trains` | UK National Rail departures |
| `nanoclaw-norish` | `/add-skill-norish` | Recipe import by URL |
| `nanoclaw-claude-mem` | `/add-skill-claude-mem` | Persistent cross-session memory |
| `nanoclaw-telegram-swarm` | `/add-skill-telegram-swarm` | Agent Teams for Telegram |

## Core Skills (in main repo)

These skills remain in the NanoClaw repository under `.claude/skills/` because they manage the framework itself:

| Skill | Purpose |
|-------|---------|
| `/nanoclaw-setup` | First-time installation and configuration |
| `/nanoclaw-debug` | Container troubleshooting and health checks |
| `/nanoclaw-set-model` | Change Claude model for containers |
| `/nanoclaw-update` | Pull fork updates, compare plugin versions |
| `/nanoclaw-add-group` | Register a group on any installed channel |
| `/nanoclaw-add-agent` | Create agent definitions for a group |
| `/nanoclaw-security-audit` | Pre-install security audit of skill plugins |
| `/nanoclaw-publish-skill` | Publish a local skill to the marketplace |
| `/create-skill-plugin` | Build a new skill plugin from scratch |
| `/create-channel-plugin` | Build a new channel plugin from scratch |

## Publishing Skills

To publish a locally-created skill to the marketplace:

1. Create your skill with `/create-skill-plugin` or `/create-channel-plugin`
2. Test it locally
3. Run `/nanoclaw-publish-skill {name}` to restructure and push to the marketplace

The publish skill handles the conversion from local `.claude/skills/add-*` format to the marketplace plugin format (`.claude-plugin/plugin.json`, `skills/`, `files/`).

## How It Works

The marketplace uses Claude Code's native plugin system:

- **`.claude-plugin/marketplace.json`** — Central catalog listing all 27 plugins with metadata and categories
- **`plugins/nanoclaw-*/`** — Each plugin has a `.claude-plugin/plugin.json` manifest, `skills/` directory with the SKILL.md, and `files/` directory with templates
- **`${CLAUDE_PLUGIN_ROOT}`** — Path variable in SKILL.md files that resolves to the plugin's cache location after marketplace install
- **`.claude/settings.json`** — `extraKnownMarketplaces` config in the main repo enables auto-discovery for forkers
- **Update detection** — `/nanoclaw-update` matches installed plugin names to marketplace entries by convention (`plugins/weather/` → `nanoclaw-weather`) and diffs for changes

## Auto-Discovery

NanoClaw's `.claude/settings.json` registers the marketplace via `extraKnownMarketplaces`. When users clone a fork and open Claude Code, the marketplace is automatically available — no manual `marketplace add` needed. Skills appear in the `/plugin` Discover tab.
