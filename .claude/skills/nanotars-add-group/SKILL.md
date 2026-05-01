---
name: nanotars-add-group
description: >
  Add a channel group to NanoTars. Discovers installed channel plugins, guides through
  group registration (admin or regular), and handles channel-specific auth setup.
  Triggers on "add channel", "add channel group", "register group", "add whatsapp group",
  "add telegram group", "add discord group", "new group", "connect channel".
---

# Add Channel Group

Use the typed NanoTars CLI for discovery and pairing-code generation. Do not write entity-model SQLite rows directly from this skill.

This skill is for registering chats against existing channel plugins. Use `/create-channel-plugin` when the channel plugin itself does not exist yet.

## Inspect State

```bash
nanotars channels list
nanotars groups list
nanotars users list
```

If the selected channel is missing or unauthenticated, run:

```bash
nanotars channels auth <channel>
```

## First Main Chat

For a fresh install or when pairing the main control chat:

```bash
nanotars pair-main [--channel <name>]
```

The CLI prints a 4-digit code. Send that code from the chat that should become `main`.

## Regular Group Or DM

Choose a safe folder name with the operator, then run:

```bash
nanotars groups register-code <folder>
```

If the group folder does not exist, the CLI creates the agent group and initializes its filesystem. Send the printed code from the target chat.

## Move A Group To Another Channel

Use this only for moving an existing agent group folder to a different channel plugin. It is not for moving one group folder into another group folder.

Preview:

```bash
nanotars migrate-channel <folder> --from-channel <source> --to-channel <destination>
```

Apply:

```bash
nanotars migrate-channel <folder> --from-channel <source> --to-channel <destination> --apply
```

The apply path allocates a destination-channel pairing code. When that code is claimed from the destination chat, NanoTars wires the existing group folder to the new chat, moves scheduled tasks for the old source chat id to the new chat id, and removes the old source-channel binding.

## Verify

After the code is claimed:

```bash
nanotars groups show <folder>
nanotars tasks list --group <folder>
nanotars logs errors
```

If auth or routing looks wrong, switch to `/nanotars-debug`.
