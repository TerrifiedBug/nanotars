// src/providers/provider-container-registry.ts
/**
 * Host-side provider container-config registry.
 *
 * Providers that need per-spawn host-side setup (extra mounts, env passthrough,
 * per-session directories) register a contribution function. The container-
 * runner resolves the agent group's agent_provider, looks up the registered fn,
 * and merges the returned mounts/env into the spawn args.
 *
 * Providers without host-side needs (claude, mock) don't appear here.
 *
 * Plugin-loader populates this registry at startup when it sees
 * manifest.agentProvider === true (5A-06).
 *
 * Mirrors v2's src/providers/provider-container-registry.ts.
 */

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface ProviderContainerContext {
  agentGroupId: string;
  groupFolder: string;
  hostEnv: NodeJS.ProcessEnv;
}

export interface ProviderContainerContribution {
  mounts?: VolumeMount[];
  env?: Record<string, string>;
}

export type ProviderContainerConfigFn = (ctx: ProviderContainerContext) => ProviderContainerContribution;

const registry = new Map<string, ProviderContainerConfigFn>();

export function registerProviderContainerConfig(name: string, fn: ProviderContainerConfigFn): void {
  if (registry.has(name)) throw new Error(`Provider container config already registered: ${name}`);
  registry.set(name, fn);
}

export function getProviderContainerConfig(name: string): ProviderContainerConfigFn | undefined {
  return registry.get(name);
}

export function listProviderContainerConfigNames(): string[] {
  return [...registry.keys()];
}

/** @internal — tests only */
export function _clearProviderContainerRegistry(): void {
  registry.clear();
}

/**
 * Resolve the effective provider name for an agent group.
 * Resolution order: agent_groups.agent_provider → 'claude'.
 * Future: per-session override when v1 grows per-session containers (Phase 6).
 */
export function resolveProviderName(agentGroupProvider: string | null | undefined): string {
  return agentGroupProvider || 'claude';
}
