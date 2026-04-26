import { describe, it, expect, beforeEach } from 'vitest';
import { pausedGate, _resetPausedGate } from '../lifecycle.js';

describe('pausedGate', () => {
  beforeEach(_resetPausedGate);

  it('starts unpaused', () => expect(pausedGate.isPaused()).toBe(false));
  it('pause sets the flag', () => {
    pausedGate.pause('test');
    expect(pausedGate.isPaused()).toBe(true);
  });
  it('resume clears the flag', () => {
    pausedGate.pause('test');
    pausedGate.resume('test');
    expect(pausedGate.isPaused()).toBe(false);
  });
  it('double-pause is a no-op', () => {
    pausedGate.pause('a');
    pausedGate.pause('b');
    expect(pausedGate.isPaused()).toBe(true);
  });
  it('resume when not paused is a no-op', () => {
    pausedGate.resume('test');
    expect(pausedGate.isPaused()).toBe(false);
  });
});
