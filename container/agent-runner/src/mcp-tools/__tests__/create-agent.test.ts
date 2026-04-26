import { describe, it, expect } from 'vitest';

import {
  buildCreateAgentPayload,
  createAgentInput,
} from '../create-agent.js';

describe('createAgentInput zod schema', () => {
  it('accepts a minimal input (just a name)', () => {
    const parsed = createAgentInput.parse({ name: 'Researcher' });
    expect(parsed.name).toBe('Researcher');
    expect(parsed.instructions).toBeUndefined();
    expect(parsed.folder).toBeUndefined();
  });

  it('accepts instructions + folder', () => {
    const parsed = createAgentInput.parse({
      name: 'Researcher',
      instructions: 'You are a research assistant',
      folder: 'researcher',
    });
    expect(parsed.instructions).toBe('You are a research assistant');
    expect(parsed.folder).toBe('researcher');
  });

  it('rejects an empty name', () => {
    expect(() => createAgentInput.parse({ name: '' })).toThrow();
  });

  it('rejects a name longer than 64 chars', () => {
    expect(() => createAgentInput.parse({ name: 'a'.repeat(65) })).toThrow();
  });

  it('rejects a folder with uppercase letters', () => {
    expect(() =>
      createAgentInput.parse({ name: 'r', folder: 'Researcher' }),
    ).toThrow();
  });

  it('rejects a folder starting with a hyphen', () => {
    expect(() =>
      createAgentInput.parse({ name: 'r', folder: '-bad' }),
    ).toThrow();
  });

  it('accepts a folder with hyphens and underscores', () => {
    const parsed = createAgentInput.parse({
      name: 'Researcher',
      folder: 'my-researcher_2',
    });
    expect(parsed.folder).toBe('my-researcher_2');
  });
});

describe('buildCreateAgentPayload', () => {
  it('builds a complete payload with default null instructions/folder', () => {
    const now = new Date('2026-04-26T12:00:00.000Z');
    const payload = buildCreateAgentPayload(
      { name: 'Researcher' },
      { groupFolder: 'main', isMain: true, now },
    );
    expect(payload).toEqual({
      type: 'create_agent',
      name: 'Researcher',
      instructions: null,
      folder: null,
      groupFolder: 'main',
      isMain: true,
      timestamp: '2026-04-26T12:00:00.000Z',
    });
  });

  it('passes through instructions when provided', () => {
    const now = new Date('2026-04-26T12:00:00.000Z');
    const payload = buildCreateAgentPayload(
      {
        name: 'Researcher',
        instructions: 'You are a research assistant',
      },
      { groupFolder: 'main', isMain: true, now },
    );
    expect(payload.instructions).toBe('You are a research assistant');
    expect(payload.folder).toBeNull();
  });

  it('passes through folder when provided', () => {
    const now = new Date('2026-04-26T12:00:00.000Z');
    const payload = buildCreateAgentPayload(
      { name: 'Researcher', folder: 'research-bot' },
      { groupFolder: 'main', isMain: false, now },
    );
    expect(payload.folder).toBe('research-bot');
    expect(payload.isMain).toBe(false);
  });

  it('payload is JSON-serialisable', () => {
    const payload = buildCreateAgentPayload(
      { name: 'r', instructions: 'i', folder: 'r' },
      { groupFolder: 'g', isMain: true, now: new Date('2026-01-01') },
    );
    const round = JSON.parse(JSON.stringify(payload));
    expect(round).toEqual(payload);
  });
});
