---
name: add-transcription
description: Add voice message transcription to NanoClaw using OpenAI's Whisper API. Automatically transcribes voice notes so the agent can read and respond to them. Triggers on "add transcription", "voice transcription", "whisper", "transcribe voice".
---

# Add Voice Transcription

Automatic voice message transcription via OpenAI's Whisper API. When users send voice notes on any channel (WhatsApp, Telegram, Discord), the transcription hook converts them to text before the agent sees the message.

Works with any channel plugin that sets `mediaType='audio'` and `mediaHostPath` on inbound messages.

## Prerequisites

- NanoClaw must be set up and running (`/setup`)
- At least one channel plugin installed with voice/audio support

## Step 1: Check Existing Configuration

```bash
grep "^OPENAI_API_KEY=" .env 2>/dev/null && echo "KEY_SET" || echo "KEY_MISSING"
[ -d plugins/transcription ] && echo "PLUGIN_EXISTS" || echo "PLUGIN_MISSING"
```

If already configured, ask the user if they want to reconfigure or just verify.

## Step 2: Get OpenAI API Key

**Use the AskUserQuestion tool** to present this:

> You'll need an OpenAI API key for Whisper transcription.
>
> Get one at: https://platform.openai.com/api-keys
>
> Cost: ~$0.006 per minute of audio (~$0.003 per typical 30-second voice note)

Wait for user to provide their API key.

## Step 3: Save to .env

```bash
# Remove existing line if present
sed -i '/^OPENAI_API_KEY=/d' .env

# Add the new key
echo "OPENAI_API_KEY=THE_KEY_HERE" >> .env
```

## Step 4: Install Plugin

```bash
cp -r .claude/skills/add-whatsapp-voice/files/ plugins/transcription/
```

The plugin loader handles `npm install` automatically on next startup (`dependencies: true` in manifest).

## Step 5: Build and Restart

```bash
npm run build
systemctl restart nanoclaw  # or launchctl on macOS
```

## Verify

Tell the user:
> Voice transcription is ready! Test it by sending a voice note in any registered chat.
>
> Voice messages appear to the agent as: `[Voice: <transcribed text>]`

Watch for transcription in the logs:
```bash
tail -f logs/nanoclaw.log | grep -i "voice\|transcri"
```

## Troubleshooting

- **"transcription unavailable"**: Check `OPENAI_API_KEY` is set in `.env` and has credits
- **Voice messages not detected**: Ensure you're sending voice notes, not audio file attachments
- **No transcription on a channel**: That channel plugin may not set `mediaType`/`mediaHostPath` on audio messages

## Remove

1. `rm -rf plugins/transcription/`
2. Remove env var: `sed -i '/^OPENAI_API_KEY=/d' .env`
3. Rebuild and restart
