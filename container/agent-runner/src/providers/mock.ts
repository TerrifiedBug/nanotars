// container/agent-runner/src/providers/mock.ts
//
// Mock provider — used by tests that want to exercise the seam without
// loading the real Claude SDK. Registers itself as 'mock' in the provider
// registry. Not loaded in production unless something explicitly imports
// './mock.js'.

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_options: ProviderOptions) {}

  query(input: QueryInput): AgentQuery {
    const events: ProviderEvent[] = [
      { type: 'init', continuation: 'mock-session' },
      { type: 'activity' },
      { type: 'result', text: `MOCK: ${input.prompt}` },
    ];
    return {
      push() {},
      end() {},
      events: (async function* () {
        for (const e of events) yield e;
      })(),
      abort() {},
    };
  }

  isSessionInvalid(): boolean {
    return false;
  }
}

registerProvider('mock', (options) => new MockProvider(options));
