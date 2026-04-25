import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { _initTestDatabase } from '../db.js';
import {
  generatePairingCode,
  acceptPairingCode,
  isPaired,
  clearPairing,
} from '../telegram-pairing.js';

beforeEach(() => {
  _initTestDatabase();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// --- generatePairingCode ---

describe('generatePairingCode', () => {
  it('returns an 8-character alphanumeric string', () => {
    const code = generatePairingCode();
    expect(code).toHaveLength(8);
    // Only chars from the ALPHABET (uppercase letters excluding O/I, digits excluding 0/1)
    expect(code).toMatch(/^[A-Z2-9]+$/);
    // Specifically excludes O, I, 0, 1
    expect(code).not.toMatch(/[OI01]/);
  });

  it('overwrites any pending code when called twice', () => {
    const code1 = generatePairingCode();
    const code2 = generatePairingCode();
    // The second code should be stored; the first should no longer accept
    expect(acceptPairingCode(code1, 'user:100')).toBe(false);
    // The second code should still work
    expect(acceptPairingCode(code2, 'user:200')).toBe(true);
  });
});

// --- acceptPairingCode ---

describe('acceptPairingCode', () => {
  it('returns true for matching code, not expired, new user', () => {
    const code = generatePairingCode();
    const result = acceptPairingCode(code, 'user:alice');
    expect(result).toBe(true);
    expect(isPaired('user:alice')).toBe(true);
  });

  it('returns false for non-matching code', () => {
    generatePairingCode();
    expect(acceptPairingCode('BADCODE1', 'user:bob')).toBe(false);
    expect(isPaired('user:bob')).toBe(false);
  });

  it('returns false for expired code', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const code = generatePairingCode();

    // Advance past the 10-minute TTL
    vi.setSystemTime(now + 11 * 60 * 1000);

    expect(acceptPairingCode(code, 'user:charlie')).toBe(false);
    expect(isPaired('user:charlie')).toBe(false);
  });

  it('returns false for already-paired user (idempotent failure)', () => {
    const code = generatePairingCode();
    // First acceptance succeeds
    expect(acceptPairingCode(code, 'user:dave')).toBe(true);

    // Generate a fresh code and try to re-pair the same user
    const code2 = generatePairingCode();
    expect(acceptPairingCode(code2, 'user:dave')).toBe(false);
  });
});

// --- isPaired ---

describe('isPaired', () => {
  it('returns true for a paired user', () => {
    const code = generatePairingCode();
    acceptPairingCode(code, 'user:eve');
    expect(isPaired('user:eve')).toBe(true);
  });

  it('returns false for an unpaired user', () => {
    expect(isPaired('user:frank')).toBe(false);
  });
});

// --- clearPairing ---

describe('clearPairing', () => {
  it('wipes paired_users and clears pending code', () => {
    const code = generatePairingCode();
    acceptPairingCode(code, 'user:grace');
    expect(isPaired('user:grace')).toBe(true);

    // Generate a new pending code to confirm it also gets wiped
    generatePairingCode();
    clearPairing();

    expect(isPaired('user:grace')).toBe(false);

    // After clear, no pending code exists — accept should fail on any input
    expect(acceptPairingCode('ANYTHNG1', 'user:newuser')).toBe(false);
  });
});
