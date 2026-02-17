# Housekeeping & Skill Cleanup Design

**Date:** 2026-02-17
**Scope:** Stale references, CHANNEL.md consolidation, documentation gaps, Waze fix, update-nanoclaw simplification

## Decision: Skip WhatsApp JID Refactor

WhatsApp JIDs (`@g.us`, `@s.whatsapp.net`) already don't overlap with prefixed channels (`tg:`, `dc:`). No functional benefit to adding a `wa:` prefix. Skipped.

## Decision: Setup Tracking

No persistent DB flag. Instead, gate all channel/skill install skills with a runtime preflight check (probes node_modules, Docker image, auth config). If any check fails, the skill tells the user to run `/nanoclaw-setup` first and stops.

---

## Group A: Stale Reference Cleanup

### A1. nanoclaw-setup/SKILL.md — registered_groups.json references

**Lines 516-522:** Replace JSON file registration with direct SQLite insert:

```sql
INSERT OR REPLACE INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at, requires_trigger, channel)
VALUES ('<JID>', '<NAME>', '<FOLDER>', '<TRIGGER>', datetime('now'), 1, '<CHANNEL>')
```

**Line 629:** Replace `data/registered_groups.json` config reference with:

```sql
UPDATE registered_groups SET container_config = json('{"additionalMounts": [...]}') WHERE jid = '<JID>'
```

### A2. add-skill-webhook/SKILL.md — line 49

Replace `Read data/registered_groups.json` with:

```sql
sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups"
```

### A3. PII protection rule

Add to `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md`:

> **Privacy rule:** Never write personally identifiable information (phone numbers, addresses, full names, email addresses, account numbers) to CLAUDE.md files. These files are checked into version control and shared across sessions. Store private facts only in claude-mem persistent memory.

### A4. Claude-mem uninstall warning

Add to the uninstall section of `.claude/skills/add-skill-claude-mem/SKILL.md`:

> **Warning:** Do NOT delete `/root/.claude-mem/`. This directory contains the shared memory database used by both the host and container agents. Removing the plugin only stops container access — the host's claude-mem continues to function independently.

### A5. Comprehensive sweep

Historical plan docs in `docs/plans/` that reference `registered_groups.json` are left as-is (historical records). Only active skill files are updated. The migration code in `src/db.ts` is correct and stays.

---

## Group B: CHANNEL.md Consolidation

### Files affected

| Channel | CHANNEL.md | SKILL.md |
|---------|-----------|----------|
| WhatsApp | `.claude/skills/add-channel-whatsapp/CHANNEL.md` | `.claude/skills/add-channel-whatsapp/SKILL.md` |
| Telegram | `.claude/skills/add-channel-telegram/CHANNEL.md` | `.claude/skills/add-channel-telegram/SKILL.md` |
| Discord | `.claude/skills/add-channel-discord/CHANNEL.md` | `.claude/skills/add-channel-discord/SKILL.md` |

### Process per channel

1. Read both files side by side
2. Identify content in CHANNEL.md not already present in SKILL.md
3. Merge unique content into SKILL.md:
   - Auth procedures → into the auth/setup step
   - Troubleshooting → new "Troubleshooting" section
   - Discovery queries → into the group registration step
4. Delete CHANNEL.md
5. Remove any "See CHANNEL.md for details" references in SKILL.md

### Content to port (identified during exploration)

**WhatsApp CHANNEL.md unique content:**
- Auth data paths (`data/channels/whatsapp/auth/creds.json`, `auth-status.txt`)
- QR code and pairing code auth methods (detailed steps)
- Error 515 handling reference
- Group discovery query
- LID JID translation explanation

**Telegram CHANNEL.md unique content:**
- BotFather token setup walkthrough
- `.env` sync to container reminder
- `/chatid` and `/ping` command reference
- Bot pool config for Agent Swarm

**Discord CHANNEL.md unique content:**
- Discord Developer Portal bot creation walkthrough
- Channel discovery via message JID query

### Update create-channel-plugin/SKILL.md

Remove `CHANNEL.md` from the generated output structure. Currently generates:
```
.claude/skills/add-channel-{name}/
├── SKILL.md
├── CHANNEL.md    ← remove
└── files/
```

Change to:
```
.claude/skills/add-channel-{name}/
├── SKILL.md      ← includes auth/troubleshooting inline
└── files/
```

---

## Group C: Skill Documentation Gaps

### C1. Preflight gate for all install skills

Add a standard Preflight section to every `add-channel-*` and `add-skill-*` SKILL.md:

```markdown
## Preflight

Before installing, verify NanoClaw is set up:

\`\`\`bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null && echo "AUTH: ok" || echo "AUTH: missing"
\`\`\`

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.
```

**Files to update:** All `add-channel-*` and `add-skill-*` SKILL.md files.

### C2. Mandatory preflight in generated skills

Update both `create-skill-plugin/SKILL.md` and `create-channel-plugin/SKILL.md` to include the preflight block as a mandatory section in every generated SKILL.md output. This ensures all future plugins get the gate automatically.

### C3. Dockerfile.partial in create-channel-plugin

Add to the channel plugin creation skill:

- Document when a channel might need a Dockerfile.partial (system packages, CLI tools)
- Add `Dockerfile.partial` as an optional output file
- Update the boundaries: `container/Dockerfile` stays off-limits, but `plugins/channels/{name}/Dockerfile.partial` is allowed
- Include example:
  ```dockerfile
  USER root
  RUN apt-get update && apt-get install -y some-package
  USER node
  ```

### C4. Dockerfile.partial in create-skill-plugin

Same addition. Document Dockerfile.partial as an optional capability for any archetype that needs container-level dependencies. Update boundaries and output structure accordingly.

---

## Group D: Waze Skill Fix

### Investigation plan

1. Test current endpoints from the server:
   - Geocoding: `curl -s "https://www.waze.com/row-SearchServer/mozi?q=London&lang=eng&origin=livemap"`
   - Routing: `curl -s "https://routing-livemap-row.waze.com/RoutingManager/routingRequest?from=x:-1.258+y:51.752&to=x:-0.128+y:51.507&at=0&returnJSON=true&nPaths=1"`
2. If 404, check if Waze changed subdomain or path structure
3. Compare with pywaze issues/PRs for any recent endpoint discoveries
4. Update `.claude/skills/add-skill-commute/files/container-skills/SKILL.md` with working endpoints

### Fallback

If Waze blocks server-side requests entirely, document the limitation and suggest alternatives.

---

## Group E: Update-Nanoclaw Simplification

### Add plugin-era preamble

Add context at the top of `.claude/skills/update-nanoclaw/SKILL.md`:

> As NanoClaw's upstream adopts the plugin architecture, customizations live in `plugins/`, `groups/`, `.claude/skills/`, and `.env` — all gitignored. When fully achieved, upstream updates become a simple `git pull` with zero conflicts. Until then, this skill provides safe merge/cherry-pick/rebase options.

### Add Quick Update path

Add before the existing detailed flow:

```markdown
## Quick Update (no conflicts expected)

\`\`\`bash
git fetch upstream
git merge upstream/main --no-edit
npm run build
\`\`\`

If the merge succeeds cleanly, skip to validation (step 5). If conflicts arise, proceed to the detailed flow below.
```

This becomes the happy path. The existing 197-line detailed flow remains as the fallback.
