---
name: nanotars-add-agent
description: >
  Add a persistent agent definition to a group. Creates agent.json, IDENTITY.md, and CLAUDE.md
  files for a specialized subagent auto-discovered by the SDK via Agent Teams.
  Triggers on "add agent", "create agent", "new agent", "agent team", "add subagent".
---

# Add Agent To Group

Use the typed NanoTars CLI for agent-team file operations. Do not copy templates or remove agent directories by hand from this skill.

Agent definitions live under `groups/<folder>/agents/<name>/` and are discovered automatically by the agent runner.

## Inspect State

```bash
nanotars groups list
nanotars agents list
nanotars agents templates
```

For one group:

```bash
nanotars agents list --group <folder>
```

## Add From Template

Ask which group and template to use. Preview first:

```bash
nanotars agents add <group> <agent-name> --template <template>
```

Apply after confirmation:

```bash
nanotars agents add <group> <agent-name> --template <template> --apply
```

Use `--replace` only after the operator confirms overwriting an existing agent directory.

## Add Custom Agent

Ask for:

- short agent name
- one-line description
- model: `haiku`, `sonnet`, `opus`, or `inherit`
- identity text
- operating instructions

Preview:

```bash
nanotars agents add <group> <agent-name> --description "<summary>" --model haiku --identity "<identity>" --instructions "<instructions>"
```

Apply:

```bash
nanotars agents add <group> <agent-name> --description "<summary>" --model haiku --identity "<identity>" --instructions "<instructions>" --apply
```

## Remove Agent

Preview:

```bash
nanotars agents remove <group> <agent-name>
```

Apply:

```bash
nanotars agents remove <group> <agent-name> --apply
```

No restart is required. New containers discover the agent files on the next run.
