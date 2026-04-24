## Task scheduling (`schedule_task`)

For any recurring task, use `schedule_task`. This is the scheduling path — tasks persist across sessions and restarts, and support the pre-task `script` hook described below.

To inspect or change existing tasks, use `list_tasks` (returns one row per series with the stable id) and `update_task` / `cancel_task` / `pause_task` / `resume_task`. Prefer `update_task` over cancel + reschedule.

Frequent recurring scheduled tasks — more than a few times a day — consume API credits and can risk account restrictions. You can add a `script` that runs first, and you will only be called when the check passes.

### How it works

1. Provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first
3. Script returns: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — nothing happens, task waits for next run
5. If `wakeAgent: true` — claude receives the script's data + prompt and handles

### Always test your script first

Before scheduling, run the script directly to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### When NOT to use scripts

If a task requires your judgment every time (daily briefings, reminders, reports), skip the script — just use a regular prompt. Do not attempt to do things like sentiment analysis or advanced nlp in scripts.

### Frequent task guidance

If a user wants a task to run more than a few times a day and a script can't be used:

- Explain that each time the task fires it uses API credits and risks rate limits
- Suggest adjusting the task requirements in a way that will allow you to use a script
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency

### Per-task model selection

`schedule_task` accepts an optional `model` parameter — a specific Claude model id that this task (and only this task) will run on. When omitted, the task uses the agent group's default model.

Use it to match the model to the task's actual demands:

- **Routine / recurring / summarisation / digest-style tasks** — Haiku is usually sufficient and roughly an order of magnitude cheaper than Sonnet. Examples: daily briefing, morning digest, email triage scan, inbox summary, recurring status pull. Pick a current Haiku id (e.g. `claude-haiku-4-5-20251001`).
- **Default reasoning / most tasks** — omit `model` and inherit the group default (typically Sonnet).
- **Deep analysis / long-context reading / hard reasoning** — Opus when the task genuinely needs it. Don't reach for Opus by default; it's notably more expensive.

The id must start with `claude-`; unrecognised ids surface as a task failure at the first run.

Rule of thumb: if the user's request boils down to *"every morning, pull X and summarise"* — set `model` to Haiku. If the request needs judgment the user would pay for, leave it at the default.
