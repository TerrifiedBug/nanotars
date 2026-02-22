/**
 * Streaming output parser for container stdout.
 * Extracts JSON payloads between sentinel markers emitted by the agent-runner.
 */

import type { ContainerOutput } from './container-runner.js';

// Default sentinel markers (backwards compatibility with non-nonce containers)
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/** Generate per-run markers from a nonce to prevent container output injection. */
export function makeMarkers(nonce: string): { start: string; end: string } {
  return {
    start: `---NANOCLAW_OUTPUT_${nonce}_START---`,
    end: `---NANOCLAW_OUTPUT_${nonce}_END---`,
  };
}

export interface OutputParserCallbacks {
  onOutput: (output: ContainerOutput) => Promise<void>;
  onSessionId?: (sessionId: string) => void;
  onActivity?: () => void;
  onParseError?: (error: unknown, rawJson: string) => void;
}

export interface OutputParser {
  feed(chunk: string): void;
  hadOutput: boolean;
  newSessionId: string | undefined;
  settled(): Promise<void>;
}

export function createOutputParser(
  callbacks: OutputParserCallbacks,
  markers?: { start: string; end: string },
): OutputParser {
  const startMarker = markers?.start ?? OUTPUT_START_MARKER;
  const endMarker = markers?.end ?? OUTPUT_END_MARKER;

  let parseBuffer = '';
  let newSessionId: string | undefined;
  let hadOutput = false;
  let outputChain = Promise.resolve();

  return {
    feed(chunk: string) {
      parseBuffer += chunk;
      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(startMarker)) !== -1) {
        // Discard noise before the start marker
        parseBuffer = parseBuffer.slice(startIdx);

        const endIdx = parseBuffer.indexOf(endMarker, startMarker.length);
        if (endIdx === -1) break; // Incomplete pair, wait for more data

        const jsonStr = parseBuffer
          .slice(startMarker.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + endMarker.length);

        try {
          const parsed: ContainerOutput = JSON.parse(jsonStr);
          if (parsed.newSessionId) {
            newSessionId = parsed.newSessionId;
            callbacks.onSessionId?.(parsed.newSessionId);
          }
          hadOutput = true;
          callbacks.onActivity?.();
          outputChain = outputChain.then(() => callbacks.onOutput(parsed));
        } catch (err) {
          callbacks.onParseError?.(err, jsonStr);
        }
      }
    },

    get hadOutput() {
      return hadOutput;
    },

    get newSessionId() {
      return newSessionId;
    },

    settled() {
      return outputChain;
    },
  };
}
