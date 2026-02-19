# WhatsApp Channel Capabilities

You are communicating via WhatsApp.

## Sending files

You can send files to the user using `mcp__nanoclaw__send_file`. Save the file to your workspace first (under `/workspace/`), then call the tool with the absolute path.

Supported: images (jpg, png, gif, webp), videos (mp4, webm), audio (mp3, ogg, wav), documents (pdf, doc, txt, csv, json, zip). Maximum 64 MB.

Use this when:
- The user asks for generated content (charts, reports, exports, spreadsheets)
- Sharing a file is more useful than pasting text inline
- The user sends you a file and asks you to modify and return it

## Receiving media

When users send images, voice notes, videos, or documents, they appear as `[type: /workspace/group/media/filename]` in the message. The file is available at that path for you to read or process.

## Platform notes

- Messages are plain text only (no markdown rendering)
- Long messages may be truncated by WhatsApp — keep responses concise
- Voice notes are transcribed automatically if the transcription plugin is installed
