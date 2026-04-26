// src/providers/__tests__/provider-container-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProviderContainerConfig,
  getProviderContainerConfig,
  listProviderContainerConfigNames,
  resolveProviderName,
  _clearProviderContainerRegistry,
} from '../provider-container-registry.js';

describe('provider-container-registry', () => {
  beforeEach(() => _clearProviderContainerRegistry());

  it('registers + retrieves a config fn', () => {
    const fn = () => ({ mounts: [{ hostPath: '/tmp/x', containerPath: '/x', readonly: true }] });
    registerProviderContainerConfig('codex', fn);
    expect(getProviderContainerConfig('codex')).toBe(fn);
  });

  it('throws on duplicate registration', () => {
    registerProviderContainerConfig('codex', () => ({}));
    expect(() => registerProviderContainerConfig('codex', () => ({}))).toThrow(/already registered/);
  });

  it('returns undefined for unregistered providers', () => {
    expect(getProviderContainerConfig('claude')).toBeUndefined();
  });

  it('lists registered names', () => {
    registerProviderContainerConfig('a', () => ({}));
    registerProviderContainerConfig('b', () => ({}));
    expect(listProviderContainerConfigNames().sort()).toEqual(['a', 'b']);
  });

  it('resolveProviderName falls back to claude', () => {
    expect(resolveProviderName(null)).toBe('claude');
    expect(resolveProviderName(undefined)).toBe('claude');
    expect(resolveProviderName('')).toBe('claude');
    expect(resolveProviderName('codex')).toBe('codex');
  });
});
