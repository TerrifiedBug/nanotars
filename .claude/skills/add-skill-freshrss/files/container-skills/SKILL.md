---
name: freshrss
description: Read and manage RSS feeds via FreshRSS. Use for news summaries, unread articles, feed management, topic searches, or daily digests. Use whenever the user asks about news, feeds, articles, or RSS.
allowed-tools: Bash(curl:*)
---

# FreshRSS RSS Reader

Access the user's self-hosted FreshRSS instance via the Google Reader API. Requires `$FRESHRSS_URL`, `$FRESHRSS_USER`, and `$FRESHRSS_API_KEY` environment variables. If not configured, tell the user to run `/add-freshrss` on the host to set it up.

**Environment variables:**
- `FRESHRSS_URL` -- Base URL of the FreshRSS instance (no trailing slash)
- `FRESHRSS_USER` -- FreshRSS username (for GReader API auth)
- `FRESHRSS_API_KEY` -- API password (set in FreshRSS > Settings > Profile > API Management)

## Authentication

FreshRSS uses the GReader API. First obtain an auth token, then use it for all requests:

```bash
# Get auth token (use the API password, not the web login password)
AUTH=$(curl -s "$FRESHRSS_URL/api/greader.php/accounts/ClientLogin" \
  -d "Email=$FRESHRSS_USER&Passwd=$FRESHRSS_API_KEY" | grep -oP 'Auth=\K.*')

echo "Auth token: $AUTH"
```

Use the token in all subsequent requests:
```bash
-H "Authorization: GoogleLogin auth=$AUTH"
```

## Common Operations

### Get unread count

```bash
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/unread-count?output=json" \
  -H "Authorization: GoogleLogin auth=$AUTH" | jq .
```

### List subscriptions (feeds)

```bash
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/subscription/list?output=json" \
  -H "Authorization: GoogleLogin auth=$AUTH" | jq '.subscriptions[] | {title, id, url: .htmlUrl}'
```

### Get unread articles

```bash
# Get newest 20 unread articles
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/stream/contents/user/-/state/com.google/reading-list?n=20&xt=user/-/state/com.google/read&output=json" \
  -H "Authorization: GoogleLogin auth=$AUTH" | jq '.items[] | {title, published: (.published | todate), summary: .summary.content[0:200], origin: .origin.title, link: .alternate[0].href}'
```

### Get all recent articles (read and unread)

```bash
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/stream/contents/user/-/state/com.google/reading-list?n=50&output=json" \
  -H "Authorization: GoogleLogin auth=$AUTH" | jq '.items[] | {title, published: (.published | todate), summary: .summary.content[0:200], origin: .origin.title}'
```

### Get articles from a specific feed

```bash
# Use feed ID from subscription list (e.g., feed/123)
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/stream/contents/FEED_ID?n=10&output=json" \
  -H "Authorization: GoogleLogin auth=$AUTH" | jq '.items[] | {title, published: (.published | todate), summary: .summary.content[0:200]}'
```

### Mark article as read

```bash
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/edit-tag" \
  -H "Authorization: GoogleLogin auth=$AUTH" \
  -d "i=ITEM_ID&a=user/-/state/com.google/read"
```

### Mark all as read for a feed

```bash
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/mark-all-as-read" \
  -H "Authorization: GoogleLogin auth=$AUTH" \
  -d "s=FEED_ID&ts=$(date +%s)000000"
```

### Star an article

```bash
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/edit-tag" \
  -H "Authorization: GoogleLogin auth=$AUTH" \
  -d "i=ITEM_ID&a=user/-/state/com.google/starred"
```

### Get starred articles

```bash
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/stream/contents/user/-/state/com.google/starred?n=20&output=json" \
  -H "Authorization: GoogleLogin auth=$AUTH" | jq '.items[] | {title, published: (.published | todate), link: .alternate[0].href}'
```

### List categories/tags

```bash
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/tag/list?output=json" \
  -H "Authorization: GoogleLogin auth=$AUTH" | jq .
```

### Add a new feed subscription

```bash
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/subscription/edit" \
  -H "Authorization: GoogleLogin auth=$AUTH" \
  -d "ac=subscribe&s=feed/https://example.com/feed.xml"
```

### Remove a feed subscription

```bash
curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/subscription/edit" \
  -H "Authorization: GoogleLogin auth=$AUTH" \
  -d "ac=unsubscribe&s=FEED_ID"
```

## Tips

- Always authenticate first and store the token in `$AUTH` before making requests
- The `n` parameter controls how many results to return (default varies)
- Article summaries contain HTML -- strip tags for clean text if needed: `| sed 's/<[^>]*>//g'`
- `published` is a Unix timestamp -- use `jq` `todate` to convert
- The `xt` parameter excludes tags (e.g., `xt=user/-/state/com.google/read` excludes read items)
- When summarizing feeds, focus on titles and sources first, then fetch full content only if the user asks for details
- For daily digests, get unread articles sorted by feed/category for a structured overview
