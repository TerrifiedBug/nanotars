---
name: nanotars-set-model
description: Change the Claude model used by NanoClaw agent containers
triggers:
  - set model
  - change model
  - switch model
  - use sonnet
  - use opus
  - use haiku
---

# Set Default Model

Changes the Claude model for agent containers. Takes effect on the next agent turn (no restart or rebuild needed).

## Available Models

| Model | ID |
|-------|-----|
| Sonnet 4.5 (default) | `claude-sonnet-4-5` |
| Opus 4.6 | `claude-opus-4-6` |
| Haiku 4.5 | `claude-haiku-4-5` |

## Steps

1. Ask the user which model they want (if not already specified)
2. Write the model ID to the store file:
   ```bash
   echo "MODEL_ID" > store/claude-model
   ```
3. Verify the file:
   ```bash
   cat store/claude-model
   ```
4. Tell the user the model is set. It takes effect on the next agent turn — no restart needed.

To revert to the SDK default (Sonnet), delete the file:
```bash
rm store/claude-model
```
