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
});
