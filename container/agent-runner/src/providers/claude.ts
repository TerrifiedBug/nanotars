// container/agent-runner/src/providers/claude.ts
//
// Claude Agent SDK provider for v1. Wraps the existing single-call site in
// container/agent-runner/src/index.ts so the rest of the file goes through
// the AgentProvider seam. Phase 5A.
//
// Design parallels v2's providers/claude.ts (queue-based MessageStream +
// translateEvents async-generator) but adapted for the v1 surface:
// - SDK package: @anthropic-ai/claude-agent-sdk (NOT @anthropic-ai/claude-code)
// - No db/connection.ts container-state tracking (v1 has no container DB yet)
// - Hooks, allowedTools, agents, MCP servers, settingSources, permission flags
//   are passed in by the caller via ClaudeProviderInput; the provider only
//   owns the iteration -> ProviderEvent translation.
//
// 5A-07 reroutes index.ts:571 through createProvider('claude').query(...).

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback, Options as SdkOptions } from '@anthropic-ai/claude-agent-sdk';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

/**
 * Claude-specific extras the caller passes via ProviderOptions. These are
 * intentionally pass-throughs to the SDK — the abstraction layer's job is to
 * own the event-translation, not to redefine every SDK surface for the one
 * provider that's the default. Other providers ignore these.
 */
export interface ClaudeProviderExtras {
  allowedTools?: string[];
  disallowedTools?: string[];
  hooks?: Record<string, Array<{ matcher?: string; hooks: HookCallback[] }>>;
  agents?: SdkOptions['agents'];
  permissionMode?: SdkOptions['permissionMode'];
  settingSources?: SdkOptions['settingSources'];
  /** Override the default for the SDK's allowDangerouslySkipPermissions. */
  allowDangerouslySkipPermissions?: boolean;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

/**
 * Stale-session detection. Matches the SDK's error text when a resumed
 * session can't be found.
 */
const STALE_SESSION_RE = /No message found with message\.uuid|no conversation found|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private options: ProviderOptions & ClaudeProviderExtras;

  constructor(options: ProviderOptions & ClaudeProviderExtras = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    const sdkOptions: SdkOptions = {
      cwd: input.cwd,
      additionalDirectories: this.options.additionalDirectories,
      resume: input.continuation,
      systemPrompt: instructions
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
        : undefined,
      allowedTools: this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
      env: this.options.env,
      permissionMode: this.options.permissionMode ?? 'bypassPermissions',
      allowDangerouslySkipPermissions: this.options.allowDangerouslySkipPermissions ?? true,
      settingSources: this.options.settingSources ?? ['project', 'user'],
      mcpServers: this.options.mcpServers,
      hooks: this.options.hooks,
      ...(this.options.agents ? { agents: this.options.agents } : {}),
      ...(input.modelOverride ? { model: input.modelOverride } : {}),
    };

    const sdkResult = sdkQuery({ prompt: stream, options: sdkOptions });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      try {
        for await (const message of sdkResult) {
          if (aborted) return;
          messageCount++;

          // Heartbeat for the host idle timer.
          yield { type: 'activity' };

          if (message.type === 'system' && message.subtype === 'init') {
            yield { type: 'init', continuation: (message as { session_id: string }).session_id };
          } else if (message.type === 'result') {
            const isError = (message as { is_error?: boolean }).is_error === true;
            const text = 'result' in message ? (message as { result?: string }).result ?? null : null;
            const errors = 'errors' in message ? (message as { errors?: string[] }).errors : undefined;
            const errorText = errors?.length ? errors.join('; ') : null;

            if (isError) {
              const combinedError = [text, errorText].filter(Boolean).join(' ');
              yield {
                type: 'error',
                message: combinedError || 'unknown SDK error',
                retryable: false,
                ...(STALE_SESSION_RE.test(combinedError) ? { classification: 'stale_session' } : {}),
              };
            } else {
              yield { type: 'result', text };
            }
          } else if (
            message.type === 'system' &&
            (message as { subtype?: string }).subtype === 'task_notification'
          ) {
            const tn = message as { summary?: string };
            yield { type: 'progress', message: tn.summary || 'Task notification' };
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield {
          type: 'error',
          message: msg,
          retryable: false,
          ...(STALE_SESSION_RE.test(msg) ? { classification: 'stale_session' } : {}),
        };
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts as ProviderOptions & ClaudeProviderExtras));
