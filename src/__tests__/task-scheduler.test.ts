import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContainerInput, ContainerOutput } from '../container-runner.js';
import type { ScheduledTask, RegisteredGroup } from '../types.js';

// --- Module mocks (hoisted before imports of the module under test) ---

vi.mock('../config.js', () => ({
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  MAIN_GROUP_FOLDER: 'main',
  SCHEDULED_TASK_IDLE_TIMEOUT: 30000,
  SCHEDULER_POLL_INTERVAL: 60000,
  TIMEZONE: 'UTC',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
    },
  };
});

vi.mock('../container-runner.js', () => ({
  runContainerAgent: vi.fn(async () => ({ status: 'success', result: null })),
  mapTasksToSnapshot: vi.fn(() => []),
  writeTasksSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
}));

vi.mock('../db.js', () => ({
  claimTask: vi.fn(),
  getAllTasks: vi.fn(() => []),
  getDueTasks: vi.fn(() => []),
  getTaskById: vi.fn(),
  isValidGroupFolder: vi.fn(() => true),
  logTaskRun: vi.fn(),
  updateTask: vi.fn(),
  updateTaskAfterRun: vi.fn(),
}));

vi.mock('../router.js', () => ({
  isAuthError: vi.fn(() => false),
  stripInternalTags: vi.fn((t: string) => t),
}));

// --- Import module under test after mocks ---
import { runTask } from '../task-scheduler.js';
import * as containerRunnerMod from '../container-runner.js';

// --- Test helpers ---

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'test-task-id',
    group_folder: 'main',
    chat_jid: 'main@g.us',
    prompt: 'do something',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    model: null,
    script: null,
    next_run: null,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const mainGroup: RegisteredGroup = {
  name: 'Main Chat',
  folder: 'main',
  pattern: '@TARS',
  added_at: '2025-01-01T00:00:00.000Z',
  engage_mode: 'always',
  sender_scope: 'all',
  ignored_message_policy: 'drop',
};

function makeDeps() {
  return {
    registeredGroups: vi.fn(() => ({ 'main@g.us': mainGroup })),
    getSessions: vi.fn(() => ({})),
    getResumePositions: vi.fn(() => ({})),
    clearResumePosition: vi.fn(),
    queue: {
      enqueueTask: vi.fn(),
      enqueueMessageCheck: vi.fn(),
      sendMessage: vi.fn(() => false),
      closeStdin: vi.fn(),
      registerProcess: vi.fn(),
      notifyIdle: vi.fn(),
    } as any,
    onProcess: vi.fn(),
    sendMessage: vi.fn(async () => {}),
  };
}

// --- Tests ---

describe('task-scheduler passes script to container', () => {
  let capturedInputs: ContainerInput[];

  beforeEach(() => {
    capturedInputs = [];
    const mockFn = vi.mocked(containerRunnerMod.runContainerAgent);
    mockFn.mockClear();
    mockFn.mockImplementation(
      async (
        _group: RegisteredGroup,
        input: ContainerInput,
        _onProcess: unknown,
        _onOutput: (o: ContainerOutput) => Promise<void>,
      ): Promise<ContainerOutput> => {
        capturedInputs.push(input);
        return { status: 'success', result: null };
      },
    );
  });

  it('forwards task.script as taskScript on the container input', async () => {
    const task = makeTask({
      id: 'test-task-id',
      script: "echo '{\"wakeAgent\":true}'",
    });

    await runTask(task, makeDeps());

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].taskScript).toBe("echo '{\"wakeAgent\":true}'");
    expect(capturedInputs[0].taskId).toBe('test-task-id');
  });

  it('passes undefined taskScript when task has no script', async () => {
    const task = makeTask({ id: 'no-script-task', script: null });

    await runTask(task, makeDeps());

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].taskScript).toBeUndefined();
    expect(capturedInputs[0].taskId).toBe('no-script-task');
  });

  it('always includes taskId even when script is null', async () => {
    const task = makeTask({ id: 'id-only-task', script: null });

    await runTask(task, makeDeps());

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].taskId).toBe('id-only-task');
  });
});
