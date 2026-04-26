// container/agent-runner/src/providers/factory.ts
import type { AgentProvider, ProviderOptions } from './types.js';
import { getProviderFactory } from './provider-registry.js';

export type ProviderName = string;

export function createProvider(name: ProviderName, options: ProviderOptions = {}): AgentProvider {
  return getProviderFactory(name)(options);
}

export function resolveProviderNameFromEnv(): ProviderName {
  return process.env.NANOCLAW_AGENT_PROVIDER || 'claude';
}
