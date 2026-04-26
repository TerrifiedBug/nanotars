---
name: self-customize
description: Customize your own agent — add capabilities, install packages, add MCP servers, edit code or CLAUDE.md. Use when the user asks you to add a feature, install a tool, or modify how you work.
---

# Self-Customization

You can modify your own environment. Different kinds of changes have different workflows.

## Decision Tree

**What needs to change?**

- **`CLAUDE.local.md` or files in your workspace** → Edit directly, no approval needed. Your workspace (`/workspace/agent/`) is persisted on the host. (Note: the composed `CLAUDE.md` itself is read-only and regenerated every spawn — write to `CLAUDE.local.md` instead.)
- **System package (apt) or global npm package** → `install_packages`. Requires admin approval. On approval, image rebuild + container restart happen automatically.
- **MCP server** → `add_mcp_server`. Requires admin approval. On approval, container restarts with the new server wired up (no rebuild — tsx runs TS directly).
- **A new specialist capability** → `create_agent` to spin up a dedicated agent for it.
- **Your own source code or Dockerfile** → Tell the user. Source-level changes to `/app/src` need a developer-side edit + a `git pull` on the host. You don't have direct edit access to host source from inside your container.

## Workflow: Adding a Capability via MCP Server

This is the most common self-customization. Walk through it like this:

1. The user asks for a capability you don't have ("Can you read RSS feeds?", "Can you fetch weather?")
2. Check [mcp.so](https://mcp.so) for an existing MCP server that does it
3. If one exists → call `add_mcp_server({ name: "<short>", command: "npx", args: ["<package>"], reason: "<one-line user benefit>" })`
4. The user gets an approval card. On approve, your container restarts with the new server wired up
5. The new tools become available — verify with the user that the capability works as expected

## Workflow: Installing a System Tool

When you need a binary that isn't in the base image (ffmpeg, ImageMagick, a CLI tool):

1. Check what's available — `which <tool>`, `apt list --installed | grep <tool>`
2. Decide between:
   - apt package (system-wide, persistent)
   - npm package (global, e.g., `claude-code`-style CLI)
   - workspace-local install (one-off, no approval needed; goes in `/workspace/agent/node_modules`)
3. For persistent install: `install_packages({ apt: ["<pkg>"], npm: ["<pkg>"], reason: "<one-line>" })`
4. Wait for admin approval — on approve, the image rebuilds and your container restarts automatically
5. Test the new capability once you're back online

## Workflow: Spinning Up a Specialist Agent

When the user wants something that's better as a dedicated, persistent agent (Researcher, Writer, Calendar agent):

1. Define the agent's purpose, tools, and personality
2. Call `create_agent({ name: "<Name>", instructions: "<focused CLAUDE.md content>" })`
3. The new agent_group exists immediately. The operator wires it to a chat channel via `/wire` from the host side (you don't auto-wire from inside the container).
4. Tell the user: the new agent exists; ask the operator to run `/wire` to connect it to a channel.

## Example: Adding a New MCP Tool to Yourself

User: "Can you add a tool for reading RSS feeds?"

1. Check [mcp.so](https://mcp.so) for an existing RSS MCP server
2. Found `@some-org/rss-mcp` → `add_mcp_server({ name: "rss", command: "npx", args: ["-y", "@some-org/rss-mcp"], reason: "Read RSS feeds for the user's news monitoring" })`
3. Admin approves → container restarts with the new server → done
4. Verify: `read_rss({ url: "..." })` works → tell the user.

If no suitable MCP server exists, tell the user honestly — building one from scratch is host-side work, not container-side. Suggest they ask their developer (or you, if you're working with them in Claude Code).

## Example: Installing a System Tool

User: "Can you transcribe audio?"

1. Check — `which ffmpeg` (likely not installed)
2. `install_packages({ apt: ["ffmpeg"], reason: "Audio transcription for voice messages" })`
3. Wait for admin approval — on approve, image rebuilds, container restarts
4. Test transcription once you're back online

## When NOT to Self-Customize

- **The change is for a one-off task** — just do it in your workspace, don't modify the container
- **The request is ambiguous** — ask the user what they actually need before requesting installs
- **You don't know if it will work** — prototype in your workspace first (`npm install` in `/workspace/agent/`), then promote to container-level install if it proves useful
- **It needs source-code edits** — that's host-side work. Tell the user; don't try to do it from inside the container
