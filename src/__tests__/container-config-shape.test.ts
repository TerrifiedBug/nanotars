/**
 * Phase 5B — ContainerConfig shape regression test.
 *
 * Verifies the JSON shape extension is type-only: empty objects parse, old
 * Phase 4 rows still parse without the new fields, and new Phase 5 rows
 * carrying packages/imageTag round-trip cleanly.
 */
import { describe, it, expect } from 'vitest';
import type { ContainerConfig } from '../types.js';

describe('ContainerConfig parser', () => {
  it('parses an empty object as defaults', () => {
    const c: ContainerConfig = JSON.parse('{}');
    expect(c.packages).toBeUndefined();
    expect(c.imageTag).toBeUndefined();
    expect(c.dockerfilePartials).toBeUndefined();
  });

  it('parses an old-shape (Phase 4) row without new fields', () => {
    const json = '{"additionalMounts":[{"hostPath":"~/data","readonly":true}],"timeout":600000}';
    const c: ContainerConfig = JSON.parse(json);
    expect(c.timeout).toBe(600000);
    expect(c.packages).toBeUndefined();
  });

  it('parses a Phase 5 row with new fields', () => {
    const json = '{"packages":{"apt":["curl"],"npm":[]},"imageTag":"nanoclaw-agent:abc"}';
    const c: ContainerConfig = JSON.parse(json);
    expect(c.packages?.apt).toEqual(['curl']);
    expect(c.imageTag).toBe('nanoclaw-agent:abc');
  });
});
