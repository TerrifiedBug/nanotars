// container/agent-runner/src/providers/__tests__/provider-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider, getProviderFactory, listProviderNames, _clearProviderRegistry,
} from '../provider-registry.js';
import type { AgentProvider } from '../types.js';

const fakeProvider: AgentProvider = {
  supportsNativeSlashCommands: false,
  query: () => ({ push() {}, end() {}, events: (async function*() {})(), abort() {} }),
  isSessionInvalid: () => false,
};

describe('provider-registry', () => {
  beforeEach(() => _clearProviderRegistry());

  it('registers + resolves by name', () => {
    registerProvider('fake', () => fakeProvider);
    expect(getProviderFactory('fake')()).toBe(fakeProvider);
  });

  it('throws on duplicate registration', () => {
    registerProvider('fake', () => fakeProvider);
    expect(() => registerProvider('fake', () => fakeProvider)).toThrow(/already registered/);
  });

  it('throws on unknown name with helpful list', () => {
    registerProvider('fake', () => fakeProvider);
    expect(() => getProviderFactory('missing')).toThrow(/Unknown provider: missing/);
    expect(() => getProviderFactory('missing')).toThrow(/Registered: fake/);
  });

  it('listProviderNames returns registered names', () => {
    registerProvider('a', () => fakeProvider);
    registerProvider('b', () => fakeProvider);
    expect(listProviderNames().sort()).toEqual(['a', 'b']);
  });
});
