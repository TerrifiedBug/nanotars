import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MessageOrchestrator, OrchestratorDeps } from './orchestrator.js';
import type { RegisteredGroup, NewMessage } from './types.js';

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    getRouterState: vi.fn(() => undefined),
    setRouterState: vi.fn(),
    getAllSessions: vi.fn(() => ({})),
    setSession: vi.fn(),
    getAllRegisteredGroups: vi.fn(() => ({})),
    setRegisteredGroup: vi.fn(),
    getMessagesSince: vi.fn(() => []),
    getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
    getAllChats: vi.fn(() => []),
    getAllTasks: vi.fn(() => []),
    formatMessages: vi.fn((msgs: NewMessage[]) => `formatted:${msgs.length}`),
    routeOutbound: vi.fn(async () => true),
    stripInternalTags: vi.fn((t: string) => t),
    createTriggerPattern: vi.fn((trigger: string) => new RegExp(`^${trigger}\\b`, 'i')),
    runContainerAgent: vi.fn(async () => ({
      status: 'success' as const,
      result: null,
      newSessionId: 'sess-1',
    })),
    mapTasksToSnapshot: vi.fn(() => []),
    writeTasksSnapshot: vi.fn(),
    writeGroupsSnapshot: vi.fn(),
    queue: {
      enqueueMessageCheck: vi.fn(),
      sendMessage: vi.fn(() => false),
      closeStdin: vi.fn(),
      registerProcess: vi.fn(),
    } as any,
    assistantName: 'TARS',
    mainGroupFolder: 'main',
    pollInterval: 2000,
    groupsDir: '/tmp/groups',

    dbEvents: new EventEmitter(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

const mainGroup: RegisteredGroup = {
  name: 'Main Chat',
  folder: 'main',
  trigger: '@TARS',
  added_at: '2024-01-01T00:00:00.000Z',
};

const secondaryGroup: RegisteredGroup = {
  name: 'Secondary',
  folder: 'secondary',
  trigger: '@TARS',
  added_at: '2024-01-01T00:00:00.000Z',
  requiresTrigger: true,
};

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'main@g.us',
    sender: 'user@s',
    sender_name: 'User',
    content: 'hello',
    timestamp: '2024-01-01T00:00:01.000Z',
    ...overrides,
  };
}

describe('MessageOrchestrator', () => {
  describe('loadState', () => {
    it('loads state from DB', () => {
      const deps = makeDeps({
        getRouterState: vi.fn((key) => {
          if (key === 'last_timestamp') return '2024-01-01T00:00:00.000Z';
          if (key === 'last_agent_timestamp') return '{"main@g.us":"2024-01-01T00:00:00.000Z"}';
          return undefined;
        }),
        getAllSessions: vi.fn(() => ({ main: 'sess-1' })),
        getAllRegisteredGroups: vi.fn(() => ({ 'main@g.us': mainGroup })),
      });
      const orch = new MessageOrchestrator(deps);
      orch.loadState();

      expect(orch.registeredGroups).toEqual({ 'main@g.us': mainGroup });
      expect(orch.sessions).toEqual({ main: 'sess-1' });
    });

    it('handles corrupted last_agent_timestamp', () => {
      const deps = makeDeps({
        getRouterState: vi.fn((key) => {
          if (key === 'last_agent_timestamp') return '{invalid json';
          return undefined;
        }),
      });
      const orch = new MessageOrchestrator(deps);
      orch.loadState();
      expect(deps.logger.warn).toHaveBeenCalled();
    });
  });

  describe('processGroupMessages', () => {
    it('advances cursor on success', async () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ timestamp: '2024-01-01T00:00:05.000Z' }),
        ]),
        getAllRegisteredGroups: vi.fn(() => ({ 'main@g.us': mainGroup })),
      });
      const orch = new MessageOrchestrator(deps);
      orch.loadState();
      orch.registeredGroups = { 'main@g.us': mainGroup };

      const result = await orch.processGroupMessages('main@g.us');
      expect(result).toBe(true);
      // State was saved (cursor advanced)
      expect(deps.setRouterState).toHaveBeenCalled();
    });

    it('rolls back cursor on error', async () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ timestamp: '2024-01-01T00:00:05.000Z' }),
        ]),
        runContainerAgent: vi.fn(async () => ({
          status: 'error' as const,
          result: null,
          error: 'Container crashed',
        })),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'main@g.us': mainGroup };

      const result = await orch.processGroupMessages('main@g.us');
      expect(result).toBe(false);
      // Error notification sent on first failure
      expect(deps.routeOutbound).toHaveBeenCalledWith(
        expect.anything(),
        'main@g.us',
        expect.stringContaining('[Error]'),
      );
    });

    it('skips rollback when output already sent to user', async () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ timestamp: '2024-01-01T00:00:05.000Z' }),
        ]),
        runContainerAgent: vi.fn(async (_group, _input, _onProc, onOutput) => {
          // Simulate: output sent first, then error
          if (onOutput) {
            await onOutput({ status: 'success', result: 'response text', newSessionId: 'sess-2' });
            await onOutput({ status: 'error', result: null, error: 'late error' });
          }
          return { status: 'error' as const, result: null, error: 'late error' };
        }),
        stripInternalTags: vi.fn((t: string) => t),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'main@g.us': mainGroup };

      const result = await orch.processGroupMessages('main@g.us');
      // Should return true (don't roll back) because output was already sent
      expect(result).toBe(true);
    });

    it('advances cursor after MAX_CONSECUTIVE_ERRORS', async () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ timestamp: '2024-01-01T00:00:05.000Z' }),
        ]),
        runContainerAgent: vi.fn(async () => ({
          status: 'error' as const,
          result: null,
          error: 'fail',
        })),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'main@g.us': mainGroup };

      // First two errors: rollback
      await orch.processGroupMessages('main@g.us');
      await orch.processGroupMessages('main@g.us');

      // Third error: cursor advances (no rollback)
      const result = await orch.processGroupMessages('main@g.us');
      expect(result).toBe(false);
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ errorCount: 3 }),
        expect.stringContaining('Max consecutive errors'),
      );
    });

    it('returns true for unknown group', async () => {
      const deps = makeDeps();
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = {};

      const result = await orch.processGroupMessages('unknown@g.us');
      expect(result).toBe(true);
    });

    it('returns true when no messages pending', async () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => []),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'main@g.us': mainGroup };

      const result = await orch.processGroupMessages('main@g.us');
      expect(result).toBe(true);
    });
  });

  describe('trigger pattern', () => {
    it('main group skips trigger check', async () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ content: 'no trigger here' }),
        ]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'main@g.us': mainGroup };

      const result = await orch.processGroupMessages('main@g.us');
      // Should process (not skip) even without trigger
      expect(result).toBe(true);
      expect(deps.runContainerAgent).toHaveBeenCalled();
    });

    it('non-main group requires trigger', async () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sec@g.us', content: 'no trigger' }),
        ]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'sec@g.us': secondaryGroup };

      const result = await orch.processGroupMessages('sec@g.us');
      // Should skip processing — no trigger
      expect(result).toBe(true);
      expect(deps.runContainerAgent).not.toHaveBeenCalled();
    });

    it('non-main group processes with trigger present', async () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sec@g.us', content: '@TARS hello' }),
        ]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'sec@g.us': secondaryGroup };

      const result = await orch.processGroupMessages('sec@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).toHaveBeenCalled();
    });
  });

  describe('recoverPendingMessages', () => {
    it('enqueues groups with pending messages', () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [makeMessage()]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'main@g.us': mainGroup };

      orch.recoverPendingMessages();
      expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith('main@g.us');
    });

    it('skips groups with no pending messages', () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => []),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'main@g.us': mainGroup };

      orch.recoverPendingMessages();
      expect(deps.queue.enqueueMessageCheck).not.toHaveBeenCalled();
    });
  });

  describe('startMessageLoop', () => {
    it('wakes early on dbEvents new-message', async () => {
      const dbEvents = new EventEmitter();
      const deps = makeDeps({
        dbEvents,
        pollInterval: 60000, // Long interval so we can verify early wake
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = {};

      // Track iterations via getNewMessages calls
      let loopIterations = 0;
      const originalGetNew = deps.getNewMessages as ReturnType<typeof vi.fn>;
      originalGetNew.mockImplementation(() => {
        loopIterations++;
        return { messages: [], newTimestamp: '' };
      });

      const loopPromise = orch.startMessageLoop();

      // Wait a tick for the first iteration to complete
      await new Promise((r) => setTimeout(r, 50));
      expect(loopIterations).toBe(1);

      // Emit event — should wake the loop immediately (not wait 60s)
      dbEvents.emit('new-message', 'test@g.us');

      // Wait a tick for the second iteration
      await new Promise((r) => setTimeout(r, 50));
      expect(loopIterations).toBe(2);

      // Stop the loop
      orch.stop();
      await loopPromise;
    }, 5000);
  });
});
