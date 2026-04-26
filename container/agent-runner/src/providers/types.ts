// container/agent-runner/src/providers/types.ts

/**
 * Provider abstraction seam — Phase 5A.
 *
 * The existing single-call-to-claude-sdk path in container/agent-runner/src/index.ts
 * gets wrapped into the `claude` provider's query(). Future Codex/OpenCode/Ollama
 * providers ship as plugins (v1) with their own AgentProvider impl.
 *
 * Resolution order at startup: process.env.NANOCLAW_AGENT_PROVIDER ?? 'claude'.
 * The host writes NANOCLAW_AGENT_PROVIDER from agent_groups.agent_provider
 * (or 'claude' fallback) at container spawn.
 */

export interface AgentProvider {
  readonly supportsNativeSlashCommands: boolean;
  query(input: QueryInput): AgentQuery;
  isSessionInvalid(err: unknown): boolean;
}

export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
}

export interface QueryInput {
  prompt: string;
  continuation?: string;
  cwd: string;
  systemContext?: { instructions?: string };
  modelOverride?: string;
  /**
   * Phase 5A: Claude-specific resume-checkpoint (last assistant uuid). Maps
   * to `resumeSessionAt` on the agent SDK. Other providers ignore.
   */
  resumeAt?: string;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentQuery {
  push(message: string): void;
  end(): void;
  events: AsyncIterable<ProviderEvent>;
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  | { type: 'activity' }
  /**
   * Phase 5A: Claude-specific resumeAt tracking. The agent SDK uses
   * `message.uuid` on assistant messages as a checkpoint for `resumeSessionAt`.
   * Other providers may never emit this; consumers should treat it as
   * optional.
   */
  | { type: 'assistant_message'; uuid: string };
