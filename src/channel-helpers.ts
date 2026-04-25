/**
 * Split outbound text into chunks each ≤ `limit` characters.
 *
 * Four-tier fallback for the split point: `\n\n` (paragraph break) → `\n`
 * (line break) → ` ` (word break) → hard cut at `limit`. Each chunk is
 * `.trimEnd()`-ed, and the next chunk's leading whitespace is `.trimStart()`-ed.
 *
 * Adopted verbatim from upstream nanoclaw v2
 * src/channels/chat-sdk-bridge.ts:104-118.
 */
export function splitForLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export type TelegramMediaKind = 'photo' | 'video' | 'audio' | 'document';

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.opus', '.m4a', '.wav']);

/**
 * Classify a filename for Telegram's typed-media endpoints.
 *
 * Telegram's Bot API has separate methods (sendPhoto/sendVideo/sendAudio/sendDocument)
 * with different display behaviors. This helper routes based on extension —
 * a misclassified file falls back to sendDocument which works for everything
 * but loses the inline-preview UX.
 *
 * Files with no extension or unknown extensions are classified as 'document'.
 *
 * Adopted from upstream nanoclaw v2 src/channels/telegram.ts:25-35.
 */
export function mediaKindFromExtension(filename: string): TelegramMediaKind {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === filename.length - 1) return 'document';
  const ext = filename.slice(dotIndex).toLowerCase();
  if (PHOTO_EXTENSIONS.has(ext)) return 'photo';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'document';
}
