/**
 * Split outbound text into chunks each ≤ `limit` characters.
 *
 * Prefers splitting at the last newline before the limit; falls back to a
 * hard-split when no newline is available. Returns `['']` for empty input
 * rather than `[]` so callers always have at least one chunk to send.
 *
 * Adopted from upstream nanoclaw v2 src/channels/chat-sdk-bridge.ts:104-118.
 */
export function splitForLimit(text: string, limit: number): string[] {
  if (text.length === 0) return [''];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit + 1);
    const lastNewline = slice.lastIndexOf('\n');
    const splitAt = lastNewline > 0 ? lastNewline : limit;
    chunks.push(remaining.slice(0, splitAt));
    // Skip the newline character itself when split on a newline boundary
    remaining = remaining.slice(lastNewline > 0 ? splitAt + 1 : splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
