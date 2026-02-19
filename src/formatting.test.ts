import { describe, it, expect } from 'vitest';

import { TRIGGER_PATTERN, createTriggerPattern, ASSISTANT_NAME } from './config.js';
import {
  escapeXml,
  formatMessages,
  stripInternalTags,
} from './router.js';
import { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'group@g.us',
    sender: '123@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles multiple special characters together', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('passes through strings with no special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  it('formats a single message as XML', () => {
    const result = formatMessages([makeMsg()]);
    expect(result).toBe(
      '<messages>\n' +
        '<message sender="Alice" time="2024-01-01T00:00:00.000Z">hello</message>\n' +
        '</messages>',
    );
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({ id: '1', sender_name: 'Alice', content: 'hi', timestamp: 't1' }),
      makeMsg({ id: '2', sender_name: 'Bob', content: 'hey', timestamp: 't2' }),
    ];
    const result = formatMessages(msgs);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('>hi</message>');
    expect(result).toContain('>hey</message>');
  });

  it('escapes special characters in sender names', () => {
    const result = formatMessages([makeMsg({ sender_name: 'A & B <Co>' })]);
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
  });

  it('escapes special characters in content', () => {
    const result = formatMessages([
      makeMsg({ content: '<script>alert("xss")</script>' }),
    ]);
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('handles empty array', () => {
    const result = formatMessages([]);
    expect(result).toBe('<messages>\n\n</messages>');
  });
});

// --- TRIGGER_PATTERN ---

describe('TRIGGER_PATTERN', () => {
  const name = ASSISTANT_NAME;

  it(`matches @${ASSISTANT_NAME} at start of message`, () => {
    expect(TRIGGER_PATTERN.test(`@${name} hello`)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(TRIGGER_PATTERN.test(`@${name.toLowerCase()} hello`)).toBe(true);
    expect(TRIGGER_PATTERN.test(`@${name.toUpperCase()} hello`)).toBe(true);
  });

  it('does not match when not at start of message', () => {
    expect(TRIGGER_PATTERN.test(`hello @${name}`)).toBe(false);
  });

  it('does not match partial name like @TARSbot', () => {
    expect(TRIGGER_PATTERN.test(`@${name}bot hello`)).toBe(false);
  });

  it('matches with word boundary before apostrophe', () => {
    expect(TRIGGER_PATTERN.test(`@${name}'s thing`)).toBe(true);
  });

  it(`matches @${ASSISTANT_NAME} alone (end of string is a word boundary)`, () => {
    expect(TRIGGER_PATTERN.test(`@${name}`)).toBe(true);
  });

  it('matches with leading whitespace after trim', () => {
    expect(TRIGGER_PATTERN.test(`@${name} hey`.trim())).toBe(true);
  });
});

describe('createTriggerPattern (per-group)', () => {
  it('creates pattern from custom trigger string', () => {
    const pattern = createTriggerPattern('@CustomBot');
    expect(pattern.test('@CustomBot hello')).toBe(true);
    expect(pattern.test('@custombot hello')).toBe(true);
    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(false);
  });

  it('respects word boundaries', () => {
    const pattern = createTriggerPattern('@Bot');
    expect(pattern.test('@Bot hello')).toBe(true);
    expect(pattern.test('@Botnet hello')).toBe(false);
    expect(pattern.test("@Bot's thing")).toBe(true);
  });

  it('only matches at start of message', () => {
    const pattern = createTriggerPattern('@Bot');
    expect(pattern.test('hello @Bot')).toBe(false);
  });

  it('falls back to global TRIGGER_PATTERN for empty trigger', () => {
    const pattern = createTriggerPattern('');
    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(true);
  });
});

// --- Outbound formatting (internal tag stripping + prefix) ---

describe('stripInternalTags', () => {
  it('strips single-line internal tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multi-line internal tags', () => {
    expect(
      stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world'),
    ).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(
      stripInternalTags(
        '<internal>a</internal>hello<internal>b</internal>',
      ),
    ).toBe('hello');
  });

  it('returns empty string when text is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });

  it('strips unclosed internal tag at end of text', () => {
    expect(stripInternalTags('hello <internal>secret reasoning')).toBe(
      'hello',
    );
  });

  it('strips unclosed internal tag with newlines', () => {
    expect(
      stripInternalTags('hello <internal>\nsecret\nreasoning\nstuff'),
    ).toBe('hello');
  });

  it('strips closed tags first, then unclosed remainder', () => {
    expect(
      stripInternalTags(
        'before <internal>closed</internal> middle <internal>unclosed tail',
      ),
    ).toBe('before  middle');
  });
});

// --- Trigger gating with requiresTrigger flag ---

describe('trigger gating (requiresTrigger interaction)', () => {
  // Replicates the exact logic from processGroupMessages and startMessageLoop:
  //   if (!isMainGroup && group.requiresTrigger !== false) { check trigger }
  function shouldRequireTrigger(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
  ): boolean {
    return !isMainGroup && requiresTrigger !== false;
  }

  function shouldProcess(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
    messages: NewMessage[],
    trigger?: string,
  ): boolean {
    if (!shouldRequireTrigger(isMainGroup, requiresTrigger)) return true;
    const pattern = createTriggerPattern(trigger || `@${ASSISTANT_NAME}`);
    return messages.some((m) => pattern.test(m.content.trim()));
  }

  it('main group always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, undefined, msgs)).toBe(true);
  });

  it('main group processes even with requiresTrigger=true', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, true, msgs)).toBe(true);
  });

  it('non-main group with requiresTrigger=undefined requires trigger (defaults to true)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true requires trigger', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, true, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true processes when trigger present', () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(false, true, msgs)).toBe(true);
  });

  it('non-main group with requiresTrigger=false always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, false, msgs)).toBe(true);
  });

  it('uses per-group trigger instead of global ASSISTANT_NAME', () => {
    const msgs = [makeMsg({ content: '@CustomBot do something' })];
    expect(shouldProcess(false, true, msgs, '@CustomBot')).toBe(true);
    // Same message should NOT trigger with global default
    expect(shouldProcess(false, true, msgs)).toBe(false);
  });

  it('per-group trigger is case-insensitive', () => {
    const msgs = [makeMsg({ content: '@custombot do something' })];
    expect(shouldProcess(false, true, msgs, '@CustomBot')).toBe(true);
  });
});
