---
name: nanotars-set-model
description: Change the Claude model used by NanoTars agent containers
triggers:
  - set model
  - change model
  - switch model
  - use sonnet
  - use opus
  - use haiku
---

# Set Default Model

Use the typed NanoTars CLI. Do not write `store/claude-model` directly.

## Show Current Model

```bash
nanotars model get
```

## Set Model

Ask which model the operator wants if they did not specify one.

Supported shortcuts:

| Shortcut | Model ID |
|---|---|
| `sonnet` | `claude-sonnet-4-5` |
| `opus` | `claude-opus-4-6` |
| `haiku` | `claude-haiku-4-5` |

Run:

```bash
nanotars model set <model>
```

The change takes effect on the next agent turn. No restart is required.

## Reset

```bash
nanotars model reset
```
