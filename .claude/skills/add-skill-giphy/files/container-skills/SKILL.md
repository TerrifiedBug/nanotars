---
name: gif-search
description: Search and send GIFs using the Giphy API. Use sparingly for humor.
allowed-tools: Bash(python3:*), Bash(curl:*)
---

# GIF Search

Search for GIFs via Giphy. Requires `$GIPHY_API_KEY` environment variable.

## When to Send GIFs

- Only when humor is appropriate (check your humor setting)
- To emphasize a reaction, not as a replacement for a real answer
- Sparingly — one GIF per conversation at most, never multiple in a row
- Never during serious or sensitive topics

## How to Search

```bash
python3 /workspace/.claude/skills/gif-search/scripts/gif-search.py "deal with it"
```

Returns JSON array with gif and mp4 URLs and descriptions. Pick the most relevant result.

## How to Send

Download the GIF and send via IPC:

```bash
curl -sL "<gif_url>" -o /workspace/group/media/reaction.gif
```

Then write a send_file IPC message:

```bash
cat > /workspace/ipc/messages/gif-$(date +%s).json << 'GIFJSON'
{"type":"send_file","chatJid":"CHAT_JID","filePath":"/workspace/group/media/reaction.gif","caption":""}
GIFJSON
```

## Tips

- Use specific search terms ("mind blown explosion" not "funny")
- Prefer the `gif_url` — it works across all channels. Use `mp4_url` only if GIF is unavailable.
- If the search returns no results, don't mention it — just skip the GIF
