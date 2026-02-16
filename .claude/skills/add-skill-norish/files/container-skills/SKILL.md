---
name: norish
description: Import recipes into Norish by posting a URL. Use when the user shares a recipe link or asks to save a recipe.
allowed-tools: Bash(curl:*)
---

# Norish Recipe Import

Import recipes by sending a URL to the Norish API. The service scrapes the recipe automatically.

```bash
curl -s -X POST "${NORISH_URL}/api/import/recipe" \
  -H "x-api-key: ${NORISH_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"url": "RECIPE_URL_HERE"}'
```

## Response Status

- `"queued"` (202) — recipe is being imported, will appear shortly
- `"exists"` (200) — recipe was already imported before
- `"duplicate"` (409) — another import for this URL is already in progress

## Tips

- Extract the recipe URL from the user's message — it may be buried in other text
- If the response is `queued`, tell the user the recipe is being imported and will appear in Norish shortly
- If the response is `exists`, let them know they already have this recipe saved
