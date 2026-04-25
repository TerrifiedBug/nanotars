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
