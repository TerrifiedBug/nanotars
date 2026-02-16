---
name: changedetection
description: Monitor websites for changes using changedetection.io. Create watches for price tracking, stock alerts, and content monitoring. Use for price monitoring, wishlist tracking, or any website change detection.
allowed-tools: Bash(curl:*)
---

# Website Monitoring with ChangeDetection.io

Monitor websites for price changes, stock availability, and content updates. Requires `$CHANGEDETECTION_URL` and `$CHANGEDETECTION_API_KEY` environment variables. If not configured, tell the user to run `/add-changedetection` on the host to set it up.

## Authentication

All requests use the `x-api-key` header:
```bash
curl -s "${CHANGEDETECTION_URL}/api/v1/watch" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}"
```

## Creating a Watch

### Basic watch
```bash
curl -s -X POST "${CHANGEDETECTION_URL}/api/v1/watch" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/product-page",
    "title": "Product Name - Price Watch"
  }'
```

### Price monitoring watch (with webhook notification)
```bash
curl -s -X POST "${CHANGEDETECTION_URL}/api/v1/watch" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/product-page",
    "title": "Product Name - Price Watch",
    "include_filters": [".price", ".product-price", "[data-price]"],
    "processor": "restock_diff",
    "track_ldjson_price_data": true,
    "time_between_check": {"hours": 4},
    "notification_urls": ["json://'"${NANOCLAW_WEBHOOK_URL}"'"],
    "notification_title": "Price Change: {watch_title}",
    "notification_body": "{watch_url} changed. Check the latest snapshot.",
    "notification_format": "text"
  }'
```

### Watch with CSS selector for specific element
```bash
curl -s -X POST "${CHANGEDETECTION_URL}/api/v1/watch" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/product",
    "title": "Descriptive title",
    "include_filters": ["div.price-container", "span.current-price"],
    "subtractive_selectors": ["div.ads", "nav", "footer"],
    "time_between_check": {"hours": 6}
  }'
```

## Webhook Notification Setup

To have changedetection.io notify NanoClaw when a change is detected, use the `notification_urls` field with the NanoClaw webhook:

```
json://NANOCLAW_HOST:3457/webhook
```

The `NANOCLAW_WEBHOOK_URL` env var contains the full webhook URL if configured. The notification will be POSTed as JSON to NanoClaw's webhook endpoint.

**Important:** The webhook needs the Bearer token. When setting up notifications, use this format:
```
json://NANOCLAW_HOST:3457/webhook?+HeaderName=Authorization&-Authorization=Bearer+WEBHOOK_SECRET
```

Or configure the notification in changedetection.io's global settings UI to include the Authorization header.

## Listing Watches

```bash
# List all watches (returns UUID-keyed dictionary)
curl -s "${CHANGEDETECTION_URL}/api/v1/watch" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}" | python3 -c "
import sys, json
watches = json.load(sys.stdin)
for uuid, w in watches.items():
    title = w.get('title', 'Untitled')
    url = w.get('url', '')
    last = w.get('last_changed', 'never')
    print(f'{title}: {url} (last changed: {last}, uuid: {uuid})')
"
```

## Getting Watch Details

```bash
curl -s "${CHANGEDETECTION_URL}/api/v1/watch/WATCH_UUID" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}"
```

## Getting Latest Snapshot

```bash
# Get history timestamps
curl -s "${CHANGEDETECTION_URL}/api/v1/watch/WATCH_UUID/history" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}"

# Get latest snapshot content
curl -s "${CHANGEDETECTION_URL}/api/v1/watch/WATCH_UUID/history/latest" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}"
```

## Comparing Changes

```bash
# Compare previous vs latest snapshot
curl -s "${CHANGEDETECTION_URL}/api/v1/watch/WATCH_UUID/difference/previous/latest?format=text" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}"
```

## Updating a Watch

```bash
curl -s -X PUT "${CHANGEDETECTION_URL}/api/v1/watch/WATCH_UUID" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "time_between_check": {"hours": 1},
    "include_filters": [".new-price-selector"]
  }'
```

## Deleting a Watch

```bash
curl -s -X DELETE "${CHANGEDETECTION_URL}/api/v1/watch/WATCH_UUID" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}"
```

## Trigger Immediate Recheck

```bash
curl -s "${CHANGEDETECTION_URL}/api/v1/watch/WATCH_UUID?recheck=1" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}"
```

## Price Monitoring Workflow

When monitoring prices from a Notion wishlist:

1. Read the wishlist from Notion (use the `notion` skill)
2. For each product URL, create a watch with:
   - `include_filters` targeting the price element (inspect the page to find the right CSS selector)
   - `processor: "restock_diff"` for e-commerce pages
   - `track_ldjson_price_data: true` to extract structured price data from JSON-LD
   - `notification_urls` pointing to NanoClaw's webhook
   - `time_between_check` set to a reasonable interval (4-12 hours for prices)
3. When a price changes, the webhook fires, and you can:
   - Fetch the diff to see old vs new price
   - Notify the user with the price change details
   - Update the Notion wishlist with the new price

## Common CSS Selectors for Prices

- Amazon: `.a-price .a-offscreen`, `#priceblock_ourprice`
- eBay: `.x-price-primary span`
- Generic: `.price`, `[data-price]`, `.product-price`
- JSON-LD: Enable `track_ldjson_price_data` instead of CSS selectors

**Tip:** If unsure about the selector, create the watch without `include_filters` first. Check the snapshot to see what content is captured, then refine with specific selectors.

## Troubleshooting

- **Watch not detecting changes**: The CSS selector might be wrong. Check the latest snapshot content to verify what's being captured.
- **Notification not firing**: Verify the webhook URL is correct and reachable from the changedetection.io host.
- **JavaScript-rendered content**: Set `fetch_backend` to `"html_webdriver"` for pages that require JavaScript rendering (requires Playwright/browser setup in changedetection.io).
