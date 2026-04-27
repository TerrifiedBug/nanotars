import { describe, it, expect } from 'vitest';

import { shellQuote } from '../container-mounts.js';

describe('shellQuote', () => {
  it('wraps plain value in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('escapes inner single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('neutralises $() and backticks', () => {
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(shellQuote('`id`')).toBe("'`id`'");
  });

  it('handles embedded hash (comment char)', () => {
    expect(shellQuote('value#notacomment')).toBe("'value#notacomment'");
  });

  it('handles empty string', () => {
    expect(shellQuote('')).toBe("''");
  });
});
