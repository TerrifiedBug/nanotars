import { describe, it, expect } from 'vitest';

import {
  buildEmergencyStopPayload,
  buildResumeProcessingPayload,
  emergencyStopInput,
  resumeProcessingInput,
} from '../lifecycle.js';

describe('emergencyStopInput zod schema', () => {
  it('accepts an empty input (reason optional)', () => {
    const parsed = emergencyStopInput.parse({});
    expect(parsed.reason).toBeUndefined();
  });

  it('accepts a reason string', () => {
    const parsed = emergencyStopInput.parse({ reason: 'user said stop' });
    expect(parsed.reason).toBe('user said stop');
  });

  it('rejects non-string reason', () => {
    expect(() => emergencyStopInput.parse({ reason: 123 })).toThrow();
  });
});

describe('resumeProcessingInput zod schema', () => {
  it('accepts an empty input', () => {
    const parsed = resumeProcessingInput.parse({});
    expect(parsed.reason).toBeUndefined();
  });

  it('accepts a reason string', () => {
    const parsed = resumeProcessingInput.parse({ reason: 'all clear' });
    expect(parsed.reason).toBe('all clear');
  });
});

describe('buildEmergencyStopPayload', () => {
  it('builds a complete IPC payload from a minimal input', () => {
    const now = new Date('2026-04-26T12:00:00.000Z');
    const payload = buildEmergencyStopPayload(
      {},
      { groupFolder: 'main', isMain: true, now },
    );
    expect(payload).toEqual({
      type: 'emergency_stop',
      groupFolder: 'main',
      isMain: true,
      timestamp: '2026-04-26T12:00:00.000Z',
    });
    // reason should be omitted (not undefined-property) when not provided
    expect('reason' in payload).toBe(false);
  });

  it('passes through the reason when provided', () => {
    const now = new Date('2026-04-26T12:00:00.000Z');
    const payload = buildEmergencyStopPayload(
      { reason: 'user said stop' },
      { groupFolder: 'main', isMain: true, now },
    );
    expect(payload.reason).toBe('user said stop');
    expect(payload.type).toBe('emergency_stop');
  });

  it('payload is JSON-serialisable', () => {
    const payload = buildEmergencyStopPayload(
      { reason: 'r' },
      { groupFolder: 'g', isMain: false, now: new Date('2026-01-01') },
    );
    const round = JSON.parse(JSON.stringify(payload));
    expect(round).toEqual(payload);
  });
});

describe('buildResumeProcessingPayload', () => {
  it('builds a complete IPC payload from a minimal input', () => {
    const now = new Date('2026-04-26T12:00:00.000Z');
    const payload = buildResumeProcessingPayload(
      {},
      { groupFolder: 'main', isMain: true, now },
    );
    expect(payload).toEqual({
      type: 'resume_processing',
      groupFolder: 'main',
      isMain: true,
      timestamp: '2026-04-26T12:00:00.000Z',
    });
    expect('reason' in payload).toBe(false);
  });

  it('passes through the reason when provided', () => {
    const payload = buildResumeProcessingPayload(
      { reason: 'all clear' },
      { groupFolder: 'main', isMain: false, now: new Date('2026-01-01') },
    );
    expect(payload.reason).toBe('all clear');
    expect(payload.isMain).toBe(false);
  });

  it('payload is JSON-serialisable', () => {
    const payload = buildResumeProcessingPayload(
      {},
      { groupFolder: 'g', isMain: true, now: new Date('2026-01-01') },
    );
    const round = JSON.parse(JSON.stringify(payload));
    expect(round).toEqual(payload);
  });
});
