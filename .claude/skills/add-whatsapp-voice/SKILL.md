---
name: add-whatsapp-voice
description: Add WhatsApp voice message transcription to NanoClaw using OpenAI's Whisper API. Automatically transcribes voice notes so the agent can read and respond to them. Triggers on "add whatsapp voice", "voice transcription", "whisper", "transcribe voice".
---

# Add WhatsApp Voice Transcription

Automatic voice message transcription via OpenAI's Whisper API. When users send voice notes in WhatsApp, the transcription hook converts them to text before the agent sees the message.

## Prerequisites

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to present this:

> You'll need an OpenAI API key for Whisper transcription.
>
> Get one at: https://platform.openai.com/api-keys
>
> Cost: ~$0.006 per minute of audio (~$0.003 per typical 30-second voice note)
>
> Once you have your API key, we'll configure it securely.

Wait for user to confirm they have an API key before continuing.

## Install

1. Create the transcription configuration file at `.transcription.config.json`:
   ```json
   {
     "provider": "openai",
     "openai": {
       "apiKey": "",
       "model": "whisper-1"
     },
     "enabled": true,
     "fallbackMessage": "[Voice Message - transcription unavailable]"
   }
   ```
   Add it to `.gitignore`:
   ```bash
   echo ".transcription.config.json" >> .gitignore
   ```

   **Use the AskUserQuestion tool** to confirm:
   > I've created `.transcription.config.json` in the project root. You'll need to add your OpenAI API key to it manually:
   >
   > 1. Open `.transcription.config.json`
   > 2. Replace the empty `"apiKey": ""` with your key: `"apiKey": "sk-proj-..."`
   > 3. Save the file
   >
   > Let me know when you've added it.

   Wait for user confirmation.

2. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-whatsapp-voice/files/ plugins/transcription/
   ```

3. Install dependencies (use `--legacy-peer-deps` due to Zod v3/v4 conflict):
   ```bash
   cd plugins/transcription && npm install --legacy-peer-deps
   ```

4. Rebuild and restart:
   ```bash
   npm run build
   systemctl restart nanoclaw  # or launchctl on macOS
   ```

## Verify

Tell the user:
> Voice transcription is ready! Test it by:
>
> 1. Open WhatsApp on your phone
> 2. Go to a registered group chat
> 3. Send a voice note using the microphone button
> 4. The agent should receive the transcribed text and respond
>
> In the database and agent context, voice messages appear as:
> `[Voice: <transcribed text here>]`

Watch for transcription in the logs:
```bash
tail -f logs/nanoclaw.log | grep -i "voice\|transcri"
```

## Configuration

### Enable/Disable Transcription

Edit `.transcription.config.json`:
```json
{
  "enabled": false
}
```

### Change Fallback Message
```json
{
  "fallbackMessage": "[Voice note - transcription unavailable]"
}
```

## Troubleshooting

- **"Transcription unavailable"**: Check API key in `.transcription.config.json` and OpenAI credits
- **Voice messages not detected**: Ensure you're sending voice notes (microphone button), not audio file attachments
- **Dependency conflicts**: Always use `cd plugins/transcription && npm install --legacy-peer-deps`

## Remove

1. `rm -rf plugins/transcription/`
2. `rm -f .transcription.config.json`
3. Rebuild and restart.
