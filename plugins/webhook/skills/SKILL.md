---
name: webhook-alerts
description: How to handle webhook alert messages from external services
---

# Webhook Alerts

Messages from external services (Home Assistant, n8n, monitoring tools, changedetection.io) appear as messages with a `webhook:` sender prefix. These are event-driven notifications — something happened that the user asked to be alerted about.

## How to handle alerts

- Summarize them clearly and send via `send_message`
- Never suppress alerts or wrap them entirely in `<internal>` tags
- Never include raw payloads verbatim — always summarize in your own words
- If multiple alerts arrive together, group and summarize them concisely
