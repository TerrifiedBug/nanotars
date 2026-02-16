---
name: notion
description: Read and update Notion pages and databases. Use for project management, notes, documentation, and tracking information.
allowed-tools: Bash(curl:*)
---

# Notion API Access

Interact with Notion pages and databases. Requires `$NOTION_API_KEY` environment variable. If not configured, tell the user to run `/add-notion` on the host to set it up.

```bash
# Read a page
curl -s "https://api.notion.com/v1/pages/PAGE_ID" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28"

# Read page content (blocks)
curl -s "https://api.notion.com/v1/blocks/PAGE_ID/children" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28"

# Update page properties
curl -s "https://api.notion.com/v1/pages/PAGE_ID" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -X PATCH \
  -d '{"properties": {"Title": {"title": [{"text": {"content": "Updated Title"}}]}}}'

# Add content block
curl -s "https://api.notion.com/v1/blocks/PAGE_ID/children" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -X PATCH \
  -d '{"children": [{"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"type": "text", "text": {"content": "New content"}}]}}]}'
```

## Usage
- Replace PAGE_ID with actual Notion page IDs
- Page IDs found in Notion URLs: notion.so/PAGE_ID

## Tips
- Always use Notion-Version: 2022-06-28 header
- Page IDs are in the URL: notion.so/PAGE_ID
- Use PATCH for updates, GET for reads
- Rich text format for content blocks
