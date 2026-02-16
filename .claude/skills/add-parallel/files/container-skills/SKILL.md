---
name: parallel
description: Web research using Parallel AI. Quick web search and deep research tasks with citations. Uses native MCP tools.
allowed-tools: mcp__parallel-search(*), mcp__parallel-task(*)
---

# Parallel AI Web Research

Search the web and run deep research tasks via Parallel AI's MCP integration. If MCP tools are not available, tell the user to run `/add-parallel` on the host to set it up.

## How It Works

Parallel AI provides two MCP servers. Look for tools prefixed with `mcp__parallel-search` and `mcp__parallel-task`.

## Quick Web Search (`mcp__parallel-search`)

**When to use:** Freely, for factual lookups, current events, definitions, recent information, or verifying facts.

**Speed:** Fast (2-5 seconds)
**Cost:** Low
**Permission:** Not needed -- use whenever it helps answer the question

Examples:
- "Who won the 2026 Super Bowl?"
- "What's the current weather in London?"
- "Latest developments in quantum computing"

## Deep Research (`mcp__parallel-task`)

**When to use:** Comprehensive analysis, learning about complex topics, comparing concepts, historical overviews, or structured research.

**Speed:** Slower (1-20 minutes depending on depth)
**Cost:** Higher
**Permission:** ALWAYS ask the user first before using this tool

**How to ask permission:**
> I can do deep research on [topic] using Parallel's Task API. This will take a few minutes and provide comprehensive analysis with citations. Should I proceed?

**After permission -- DO NOT BLOCK! Use scheduler instead:**

1. Create the task using `mcp__parallel-task__create_task_run`
2. Get the `run_id` from the response
3. Create a polling scheduled task using `mcp__nanoclaw__schedule_task`:
   - Prompt: Check the Parallel AI task run [run_id], send results when ready via `mcp__nanoclaw__send_message`, and mark done with `mcp__nanoclaw__complete_scheduled_task`. If still running, do nothing (task will retry in 30s). If failed, send error and complete.
   - Schedule: interval every 30 seconds
   - Context mode: isolated
4. Send acknowledgment to the user
5. Exit immediately -- the scheduler handles polling

## Choosing Between Them

**Use Search when:**
- Quick factual lookup or current events
- Simple definition or clarification
- Verifying specific details

**Use Deep Research (with permission) when:**
- User wants comprehensive analysis
- Question requires comparison or synthesis
- Historical context or evolution of concepts
- User explicitly asks to "research" or "explain in depth"

**Default:** Prefer search for most questions. Only suggest deep research when genuinely needed.
