import { describe, it, expect, vi } from 'vitest';
import { createOutputParser, OUTPUT_START_MARKER, OUTPUT_END_MARKER } from './output-parser.js';
import type { ContainerOutput } from './container-runner.js';

function wrap(json: string): string {
  return `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`;
}

describe('createOutputParser', () => {
  it('parses a single marker pair in one chunk', async () => {
    const onOutput = vi.fn(async () => {});
    const parser = createOutputParser({ onOutput });

    const payload: ContainerOutput = { status: 'success', result: 'hello' };
    parser.feed(wrap(JSON.stringify(payload)));
    await parser.settled();

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(payload);
    expect(parser.hadOutput).toBe(true);
  });

  it('parses multiple marker pairs in one chunk', async () => {
    const onOutput = vi.fn(async () => {});
    const parser = createOutputParser({ onOutput });

    const p1: ContainerOutput = { status: 'success', result: 'first' };
    const p2: ContainerOutput = { status: 'success', result: 'second' };
    parser.feed(wrap(JSON.stringify(p1)) + wrap(JSON.stringify(p2)));
    await parser.settled();

    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(onOutput).toHaveBeenNthCalledWith(1, p1);
    expect(onOutput).toHaveBeenNthCalledWith(2, p2);
  });

  it('handles START/END/JSON split across chunks', async () => {
    const onOutput = vi.fn(async () => {});
    const parser = createOutputParser({ onOutput });

    const payload: ContainerOutput = { status: 'success', result: 'split' };
    const full = wrap(JSON.stringify(payload));
    // Split in the middle
    const mid = Math.floor(full.length / 2);
    parser.feed(full.slice(0, mid));
    expect(onOutput).not.toHaveBeenCalled();
    parser.feed(full.slice(mid));
    await parser.settled();

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(payload);
  });

  it('calls onParseError for malformed JSON', async () => {
    const onOutput = vi.fn(async () => {});
    const onParseError = vi.fn();
    const parser = createOutputParser({ onOutput, onParseError });

    parser.feed(`${OUTPUT_START_MARKER}\n{not valid json}\n${OUTPUT_END_MARKER}\n`);
    await parser.settled();

    expect(onOutput).not.toHaveBeenCalled();
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onParseError).toHaveBeenCalledWith(expect.any(SyntaxError), '{not valid json}');
    expect(parser.hadOutput).toBe(false);
  });

  it('ignores noise before markers', async () => {
    const onOutput = vi.fn(async () => {});
    const parser = createOutputParser({ onOutput });

    const payload: ContainerOutput = { status: 'success', result: 'after-noise' };
    parser.feed(`some debug output\nmore noise\n${OUTPUT_START_MARKER}\n${JSON.stringify(payload)}\n${OUTPUT_END_MARKER}\n`);
    await parser.settled();

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(payload);
  });

  it('handles null result between markers', async () => {
    const onOutput = vi.fn(async () => {});
    const parser = createOutputParser({ onOutput });

    const payload: ContainerOutput = { status: 'success', result: null };
    parser.feed(wrap(JSON.stringify(payload)));
    await parser.settled();

    expect(onOutput).toHaveBeenCalledWith(payload);
    expect(parser.hadOutput).toBe(true);
  });

  it('extracts session ID and calls onSessionId callback', async () => {
    const onOutput = vi.fn(async () => {});
    const onSessionId = vi.fn();
    const parser = createOutputParser({ onOutput, onSessionId });

    const payload: ContainerOutput = { status: 'success', result: 'done', newSessionId: 'sess-abc' };
    parser.feed(wrap(JSON.stringify(payload)));
    await parser.settled();

    expect(parser.newSessionId).toBe('sess-abc');
    expect(onSessionId).toHaveBeenCalledWith('sess-abc');
  });

  it('fires onActivity per valid output', async () => {
    const onOutput = vi.fn(async () => {});
    const onActivity = vi.fn();
    const parser = createOutputParser({ onOutput, onActivity });

    const p1: ContainerOutput = { status: 'success', result: 'a' };
    const p2: ContainerOutput = { status: 'success', result: 'b' };
    parser.feed(wrap(JSON.stringify(p1)) + wrap(JSON.stringify(p2)));
    await parser.settled();

    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it('settled() resolves after async callbacks complete', async () => {
    const order: string[] = [];
    const onOutput = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('callback');
    });
    const parser = createOutputParser({ onOutput });

    parser.feed(wrap(JSON.stringify({ status: 'success', result: 'x' })));
    await parser.settled();
    order.push('settled');

    expect(order).toEqual(['callback', 'settled']);
  });

  it('hadOutput is false when no valid output parsed', () => {
    const onOutput = vi.fn(async () => {});
    const parser = createOutputParser({ onOutput });

    parser.feed('just some random text\nno markers here\n');
    expect(parser.hadOutput).toBe(false);
    expect(parser.newSessionId).toBeUndefined();
  });

  it('handles partial start marker at end of chunk', async () => {
    const onOutput = vi.fn(async () => {});
    const parser = createOutputParser({ onOutput });

    const payload: ContainerOutput = { status: 'success', result: 'partial' };
    const full = wrap(JSON.stringify(payload));
    // Split right in the middle of START marker
    const splitPoint = OUTPUT_START_MARKER.length - 5;
    parser.feed(full.slice(0, splitPoint));
    expect(onOutput).not.toHaveBeenCalled();
    parser.feed(full.slice(splitPoint));
    await parser.settled();

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(payload);
  });
});
