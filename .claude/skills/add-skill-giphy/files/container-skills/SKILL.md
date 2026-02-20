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

Download the file and send via IPC. The search returns both `gif_url` and `mp4_url` — pick the right format for your channel (check your channel's platform notes for guidance).

```bash
curl -sL "<url>" -o /workspace/group/media/reaction.mp4
```

Then write a send_file IPC message:

```bash
cat > /workspace/ipc/messages/gif-$(date +%s).json << 'GIFJSON'
{"type":"send_file","chatJid":"CHAT_JID","filePath":"/workspace/group/media/reaction.mp4","caption":""}
GIFJSON
```

## Tips

- Use specific search terms ("mind blown explosion" not "funny")
- Use `gif_url` for platforms with native GIF support, `mp4_url` for platforms that handle video better (check your channel's platform notes)
- If the search returns no results, don't mention it — just skip the GIF
