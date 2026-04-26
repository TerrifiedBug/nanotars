import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from '../group-queue.js';
import { pausedGate, _resetPausedGate } from '../lifecycle.js';

// Mock config to control concurrency limit
vi.mock('../config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

// Mock containerRuntime so restartGroup tests can control the stop callback.
const stopMock = vi.fn(
  (_name: string, cb?: (err?: { message: string }) => void) => {
    // Default: succeed synchronously.
    if (cb) cb();
  },
);
vi.mock('../container-runtime.js', () => ({
  stop: (name: string, cb?: (err?: { message: string }) => void) =>
    stopMock(name, cb),
  cli: () => 'docker',
  ensureRunning: () => undefined,
}));

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
    _resetPausedGate();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetPausedGate();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Idle preemption ---

  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue a task while container is active (not idle)
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // closeStdin should NOT have been called (container is active, not idle)
    // Check that _close was NOT written
    const closeCalls = (fs.default.writeFileSync as any).mock.calls.filter(
      (c: any[]) => String(c[0]).includes('_close'),
    );
    expect(closeCalls).toHaveLength(0);

    // Clean up
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts container when idle and task enqueues', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a container and register its process info
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('group1@g.us', {} as any, 'container-1', 'main');

    // Signal idle
    queue.notifyIdle('group1@g.us');

    // Now enqueue a task — should preempt
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    expect(fs.default.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('_close'),
      '',
    );

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so task does not preempt', async () => {
    const fs = await import('fs');
    (fs.default.writeFileSync as any).mockClear();
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('group1@g.us', {} as any, 'container-1', 'main');

    // Signal idle, then send a message (resets idle)
    queue.notifyIdle('group1@g.us');
    queue.sendMessage('group1@g.us', 'hello');

    // Enqueue task — should NOT preempt (no longer idle)
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should not be written for preemption
    const closeCalls = (fs.default.writeFileSync as any).mock.calls.filter(
      (c: any[]) => String(c[0]).includes('_close'),
    );
    expect(closeCalls).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- pausedGate gates wakes ---

  it('pausedGate.isPaused() blocks new wakes; resume drains waiting groups', async () => {
    const processed: string[] = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Pause first, then enqueue
    pausedGate.pause('test');
    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(50);

    // No wake while paused
    expect(processMessages).not.toHaveBeenCalled();

    // Status reflects pendingMessages = true
    const status = queue.getStatus();
    const g1 = status.groups.find((g) => g.jid === 'group1@g.us');
    expect(g1?.active).toBe(false);
    expect(g1?.pendingMessages).toBe(true);

    // Resume + drain — group1 should now spawn
    pausedGate.resume('test');
    queue.resumeProcessing(); // also clears shuttingDown; drainWaiting runs
    await vi.advanceTimersByTimeAsync(50);

    expect(processed).toContain('group1@g.us');
  });

  // --- Phase 5C-04: restartGroup ---

  it('restartGroup stops the named group container and flags pendingMessages', async () => {
    stopMock.mockClear();
    let resolveProcess: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });
    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      { killed: false } as unknown as import('child_process').ChildProcess,
      'container-1',
      'main',
    );

    await queue.restartGroup('main', 'install_packages applied');
    expect(stopMock).toHaveBeenCalledWith('container-1', expect.any(Function));

    const status = queue.getStatus();
    const g1 = status.groups.find((g) => g.jid === 'group1@g.us');
    expect(g1?.pendingMessages).toBe(true);

    // Cleanup: let the existing processMessages call resolve.
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('restartGroup is a no-op when no active container matches the folder', async () => {
    stopMock.mockClear();
    await queue.restartGroup('does-not-exist', 'reason');
    expect(stopMock).not.toHaveBeenCalled();
  });

  it('restartGroup does not stop containers belonging to other folders', async () => {
    stopMock.mockClear();
    let resolveA: () => void;
    let resolveB: () => void;
    const processMessages = vi.fn(async (jid: string) => {
      await new Promise<void>((resolve) => {
        if (jid === 'a@g.us') resolveA = resolve;
        else resolveB = resolve;
      });
      return true;
    });
    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('a@g.us');
    queue.enqueueMessageCheck('b@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'a@g.us',
      { killed: false } as unknown as import('child_process').ChildProcess,
      'container-a',
      'folder-a',
    );
    queue.registerProcess(
      'b@g.us',
      { killed: false } as unknown as import('child_process').ChildProcess,
      'container-b',
      'folder-b',
    );

    await queue.restartGroup('folder-a', 'reason');
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(stopMock).toHaveBeenCalledWith('container-a', expect.any(Function));

    resolveA!();
    resolveB!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('pausedGate also blocks task enqueues', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    pausedGate.pause('test');
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    await vi.advanceTimersByTimeAsync(50);

    expect(taskFn).not.toHaveBeenCalled();
    const status = queue.getStatus();
    const g1 = status.groups.find((g) => g.jid === 'group1@g.us');
    expect(g1?.pendingTaskCount).toBe(1);

    pausedGate.resume('test');
    queue.resumeProcessing();
    await vi.advanceTimersByTimeAsync(50);

    expect(taskFn).toHaveBeenCalledTimes(1);
  });
});
