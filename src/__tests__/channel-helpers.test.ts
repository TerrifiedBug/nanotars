import { describe, it, expect } from 'vitest';
import { splitForLimit } from '../channel-helpers.js';

describe('splitForLimit', () => {
  it('returns single chunk when text fits within limit', () => {
    expect(splitForLimit('hello', 100)).toEqual(['hello']);
  });

  it('splits at the last newline before the limit', () => {
    const text = 'line1\nline2\nline3\nline4';
    const out = splitForLimit(text, 12);
    expect(out).toEqual(['line1\nline2', 'line3\nline4']);
  });

  it('hard-splits when no newline is available within limit', () => {
    const text = 'aaaaaaaaaaaaaaaaaaaa'; // 20 a's, no newlines
    const out = splitForLimit(text, 7);
    expect(out).toEqual(['aaaaaaa', 'aaaaaaa', 'aaaaaa']);
  });

  it('returns [empty-string] for empty input rather than []', () => {
    expect(splitForLimit('', 100)).toEqual(['']);
  });

  it('handles a final tail shorter than limit', () => {
    const text = 'line1\nline2\nshort';
    const out = splitForLimit(text, 11);
    expect(out).toEqual(['line1\nline2', 'short']);
  });

  it('paragraph break (\\n\\n) takes precedence over single \\n', () => {
    // 'a\n\nb\nc', limit 4:
    //   lastIndexOf('\n\n', 4) → 1; cut=1
    //   chunk = 'a\n\nb\nc'.slice(0,1).trimEnd() = 'a'
    //   remaining = '\n\nb\nc'.trimStart() = 'b\nc'  (length 4 ≤ 4, exits loop)
    const out = splitForLimit('a\n\nb\nc', 4);
    expect(out).toEqual(['a', 'b\nc']);
  });

  it('splits at last space when no newline is available within limit', () => {
    // 'aaaa bbbb cccc', limit 9:
    //   lastIndexOf('\n\n', 9) → -1, lastIndexOf('\n', 9) → -1
    //   lastIndexOf(' ', 9) → 9; cut=9
    //   chunk = 'aaaa bbbb cccc'.slice(0,9).trimEnd() = 'aaaa bbbb'
    //   remaining = ' cccc'.trimStart() = 'cccc'  (length 4 ≤ 9, exits loop)
    const out = splitForLimit('aaaa bbbb cccc', 9);
    expect(out).toEqual(['aaaa bbbb', 'cccc']);
  });

  it('trims trailing whitespace from chunks and leading whitespace from remainder', () => {
    // 'aaaa     \n     bbbb', limit 6:
    //   lastIndexOf('\n\n', 6) → -1, lastIndexOf('\n', 6) → 9 — wait, limit=6, so:
    //   lastIndexOf('\n', 6) → -1 (the \n is at index 9, past limit)
    //   lastIndexOf(' ', 6) → 5; cut=5
    //   chunk = 'aaaa     \n     bbbb'.slice(0,5).trimEnd() = 'aaaa'
    //   remaining = '     \n     bbbb'.trimStart() = 'bbbb'  (4 ≤ 6, exits loop)
    const out = splitForLimit('aaaa     \n     bbbb', 6);
    expect(out).toEqual(['aaaa', 'bbbb']);
  });
});
