import { describe, it, expect } from 'vitest';

import {
  askQuestionInput,
  buildAskQuestionPayload,
  generateQuestionId,
  normaliseAskQuestionOptions,
} from '../ask-question.js';

describe('askQuestionInput zod schema', () => {
  it('accepts a question with no options (free-form)', () => {
    const parsed = askQuestionInput.parse({ question: 'What is your name?' });
    expect(parsed.question).toBe('What is your name?');
    expect(parsed.options).toBeUndefined();
  });

  it('accepts a question with string options', () => {
    const parsed = askQuestionInput.parse({
      question: 'Pick one',
      options: ['A', 'B', 'C'],
    });
    expect(parsed.options).toEqual(['A', 'B', 'C']);
  });

  it('accepts options as objects with optional selectedLabel + value', () => {
    const parsed = askQuestionInput.parse({
      question: 'Pick',
      options: [
        { label: 'Approve', selectedLabel: 'Approved', value: 'approve' },
        { label: 'Skip' },
      ],
    });
    expect(parsed.options?.[0]).toEqual({
      label: 'Approve',
      selectedLabel: 'Approved',
      value: 'approve',
    });
    expect(parsed.options?.[1]).toEqual({ label: 'Skip' });
  });

  it('accepts mixed string + object options', () => {
    const parsed = askQuestionInput.parse({
      question: 'Pick',
      options: ['plain', { label: 'fancy', value: 'fancy-val' }],
    });
    expect(parsed.options).toHaveLength(2);
  });

  it('rejects empty question string', () => {
    expect(() => askQuestionInput.parse({ question: '' })).toThrow();
  });

  it('rejects negative expires_in_seconds', () => {
    expect(() =>
      askQuestionInput.parse({ question: 'q', expires_in_seconds: -1 }),
    ).toThrow();
  });

  it('rejects zero expires_in_seconds (must be positive)', () => {
    expect(() =>
      askQuestionInput.parse({ question: 'q', expires_in_seconds: 0 }),
    ).toThrow();
  });

  it('rejects non-integer expires_in_seconds', () => {
    expect(() =>
      askQuestionInput.parse({ question: 'q', expires_in_seconds: 1.5 }),
    ).toThrow();
  });

  it('rejects option object missing label', () => {
    expect(() =>
      askQuestionInput.parse({ question: 'q', options: [{ value: 'v' }] }),
    ).toThrow();
  });
});

describe('normaliseAskQuestionOptions', () => {
  it('returns empty array for undefined', () => {
    expect(normaliseAskQuestionOptions(undefined)).toEqual([]);
  });

  it('expands string options to {label, selectedLabel, value}', () => {
    expect(normaliseAskQuestionOptions(['A', 'B'])).toEqual([
      { label: 'A', selectedLabel: 'A', value: 'A' },
      { label: 'B', selectedLabel: 'B', value: 'B' },
    ]);
  });

  it('preserves explicit selectedLabel + value on object options', () => {
    expect(
      normaliseAskQuestionOptions([
        { label: 'Approve', selectedLabel: 'Approved', value: 'approve' },
      ]),
    ).toEqual([{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }]);
  });

  it('defaults selectedLabel + value to label when omitted', () => {
    expect(normaliseAskQuestionOptions([{ label: 'Skip' }])).toEqual([
      { label: 'Skip', selectedLabel: 'Skip', value: 'Skip' },
    ]);
  });
});

describe('generateQuestionId', () => {
  it('returns a string starting with "q-"', () => {
    const id = generateQuestionId();
    expect(id).toMatch(/^q-\d+-[a-z0-9]+$/);
  });

  it('produces distinct ids on consecutive calls', () => {
    const ids = new Set([generateQuestionId(), generateQuestionId(), generateQuestionId()]);
    expect(ids.size).toBe(3);
  });
});

describe('buildAskQuestionPayload', () => {
  it('builds a complete IPC payload from a minimal input', () => {
    const now = new Date('2026-04-25T12:00:00.000Z');
    const payload = buildAskQuestionPayload(
      { question: 'hi?' },
      { groupFolder: 'main', questionId: 'q-fixed', now },
    );
    expect(payload).toEqual({
      type: 'ask_question',
      questionId: 'q-fixed',
      title: '',
      question: 'hi?',
      options: [],
      expires_in_seconds: null,
      groupFolder: 'main',
      timestamp: '2026-04-25T12:00:00.000Z',
    });
  });

  it('passes through title + options + expiry', () => {
    const payload = buildAskQuestionPayload(
      {
        question: 'pick?',
        title: 'Pick one',
        options: ['Yes', 'No'],
        expires_in_seconds: 60,
      },
      { groupFolder: 'main', questionId: 'q-x', now: new Date(0) },
    );
    expect(payload.title).toBe('Pick one');
    expect(payload.options).toEqual([
      { label: 'Yes', selectedLabel: 'Yes', value: 'Yes' },
      { label: 'No', selectedLabel: 'No', value: 'No' },
    ]);
    expect(payload.expires_in_seconds).toBe(60);
  });

  it('generates a question id when none is provided', () => {
    const payload = buildAskQuestionPayload(
      { question: 'q' },
      { groupFolder: 'main' },
    );
    expect(payload.questionId).toMatch(/^q-\d+-[a-z0-9]+$/);
    expect(payload.groupFolder).toBe('main');
  });

  it('payload is JSON-serialisable (round-trips through JSON.stringify/parse)', () => {
    const payload = buildAskQuestionPayload(
      {
        question: 'pick?',
        title: 't',
        options: [{ label: 'A', value: 'a' }],
        expires_in_seconds: 30,
      },
      { groupFolder: 'main', questionId: 'q-1', now: new Date('2026-01-01') },
    );
    const round = JSON.parse(JSON.stringify(payload));
    expect(round).toEqual(payload);
  });
});
