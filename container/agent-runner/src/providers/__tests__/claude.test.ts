// container/agent-runner/src/providers/__tests__/claude.test.ts
import { describe, it, expect, vi } from 'vitest';

// Mock the SDK before importing the provider so the dynamic import isn't needed.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt: _prompt }: { prompt: AsyncIterable<unknown> }) => {
    // Return a synthetic SDK message stream: init -> result.
    async function* gen() {
      yield { type: 'system', subtype: 'init', session_id: 'mock-session-1' };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Echo: hello',
      };
    }
    return gen();
  },
}));

import { ClaudeProvider } from '../claude.js';

describe('ClaudeProvider', () => {
  it('streams init + result events for a single prompt', async () => {
    const provider = new ClaudeProvider({ assistantName: 'TARS' });
    const q = provider.query({ prompt: 'hello', cwd: '/workspace/group' });
    const collected: string[] = [];
    let resultText: string | null = null;
    for await (const e of q.events) {
      collected.push(e.type);
      if (e.type === 'result') {
        resultText = e.text;
        break;
      }
    }
    expect(collected).toContain('init');
    expect(collected).toContain('result');
    expect(resultText).toBe('Echo: hello');
  });

  it('isSessionInvalid matches typical SDK error strings', () => {
    const p = new ClaudeProvider({});
    expect(p.isSessionInvalid(new Error('No message found with message.uuid abc-123'))).toBe(true);
    expect(p.isSessionInvalid(new Error('no conversation found for sid'))).toBe(true);
    expect(p.isSessionInvalid(new Error('rate limited'))).toBe(false);
  });

  it('reports activity events as a heartbeat per SDK message', async () => {
    const provider = new ClaudeProvider({});
    const q = provider.query({ prompt: 'hi', cwd: '/workspace/group' });
    let activityCount = 0;
    for await (const e of q.events) {
      if (e.type === 'activity') activityCount++;
      if (e.type === 'result') break;
    }
    expect(activityCount).toBeGreaterThanOrEqual(2); // one per SDK message yielded
  });

  it('emits an error event when result.is_error is true', async () => {
    // Re-mock for this test: SDK yields an error-result.
    const provider = new ClaudeProvider({});
    // Replace the spy to return error result.
    const sdkMod = await import('@anthropic-ai/claude-agent-sdk');
    vi.spyOn(sdkMod, 'query').mockImplementationOnce((() => {
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-err' };
        yield { type: 'result', subtype: 'error', is_error: true, errors: ['boom'] };
      }
      return gen();
    }) as never);
    const q = provider.query({ prompt: 'fail', cwd: '/workspace/group' });
    let saw: { type: string; message?: string } | null = null;
    for await (const e of q.events) {
      if (e.type === 'error') {
        saw = e;
        break;
      }
    }
    expect(saw).not.toBeNull();
    expect(saw!.message).toContain('boom');
  });
});
