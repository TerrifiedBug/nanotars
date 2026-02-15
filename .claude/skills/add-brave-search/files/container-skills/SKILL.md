---
name: brave-search
description: Search the web using Brave Search API. Use for research, current events, finding information online, fact-checking, or when you need to look something up.
allowed-tools: Bash(curl:*)
---

# Web Search with Brave

Search the web for any topic using Brave Search API. Requires `$BRAVE_API_KEY` environment variable. If not configured, tell the user to run `/add-brave-search` on the host to set it up.

```bash
# Basic search
curl -s "https://api.search.brave.com/res/v1/web/search?q=your+search+query" \
  -H "X-Subscription-Token: $BRAVE_API_KEY"

# Recent results (past 24 hours)
curl -s "https://api.search.brave.com/res/v1/web/search?q=your+query&freshness=pd" \
  -H "X-Subscription-Token: $BRAVE_API_KEY"

# Specific country/language
curl -s "https://api.search.brave.com/res/v1/web/search?q=your+query&country=GB&search_lang=en" \
  -H "X-Subscription-Token: $BRAVE_API_KEY"
```

## Response Format
Returns JSON with `web.results[]` array containing:
- `title` - Page title
- `url` - Page URL
- `description` - Snippet text
- `published` - Publish date

## Freshness Options
- `pd` - Past 24 hours
- `pw` - Past week
- `pm` - Past month
- `py` - Past year

Use for: research, news, fact-checking, finding documentation, troubleshooting.
