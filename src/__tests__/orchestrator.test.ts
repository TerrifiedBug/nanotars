import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MessageOrchestrator, OrchestratorDeps } from '../orchestrator.js';
import type { RegisteredGroup, NewMessage } from '../types.js';

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    getRouterState: vi.fn(() => undefined),
    setRouterState: vi.fn(),
    recordUnregisteredSender: vi.fn(),
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
  pattern: '@TARS',
  added_at: '2024-01-01T00:00:00.000Z',
  engage_mode: 'always',
  sender_scope: 'all',
  ignored_message_policy: 'drop',
};

const secondaryGroup: RegisteredGroup = {
  name: 'Secondary',
  folder: 'secondary',
  pattern: '@TARS',
  added_at: '2024-01-01T00:00:00.000Z',
  engage_mode: 'pattern',
  sender_scope: 'all',
  ignored_message_policy: 'drop',
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

  describe('engage_mode semantics (processGroupMessages)', () => {
    it('engage_mode=always engages on every message regardless of pattern match', async () => {
      const alwaysGroup: RegisteredGroup = {
        name: 'Always',
        folder: 'always-group',
        pattern: '@TARS',
        added_at: '2024-01-01T00:00:00.000Z',
        engage_mode: 'always',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
      };
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'always@g.us', content: 'no trigger at all' }),
        ]),
        mainGroupFolder: 'other-main', // so always-group is not the main group
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'always@g.us': alwaysGroup };

      const result = await orch.processGroupMessages('always@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).toHaveBeenCalled();
    });

    it('engage_mode=pattern only engages on pattern-matching messages', async () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sec@g.us', content: 'no trigger here' }),
        ]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'sec@g.us': secondaryGroup }; // engage_mode: 'pattern'

      const result = await orch.processGroupMessages('sec@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).not.toHaveBeenCalled();
    });

    it('engage_mode=mention-sticky (Phase 4 forward-compat) currently treated as pattern', async () => {
      const mentionStickyGroup: RegisteredGroup = {
        name: 'Sticky',
        folder: 'sticky-group',
        pattern: '@TARS',
        added_at: '2024-01-01T00:00:00.000Z',
        engage_mode: 'mention-sticky',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
      };
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sticky@g.us', content: 'no trigger here' }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'sticky@g.us': mentionStickyGroup };

      // Without trigger: should NOT engage (behaves as pattern mode)
      const result = await orch.processGroupMessages('sticky@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).not.toHaveBeenCalled();
    });

    it('engage_mode=mention-sticky engages when trigger pattern matches', async () => {
      const mentionStickyGroup: RegisteredGroup = {
        name: 'Sticky',
        folder: 'sticky-group',
        pattern: '@TARS',
        added_at: '2024-01-01T00:00:00.000Z',
        engage_mode: 'mention-sticky',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
      };
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sticky@g.us', content: '@TARS hello' }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'sticky@g.us': mentionStickyGroup };

      const result = await orch.processGroupMessages('sticky@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).toHaveBeenCalled();
    });

    it('ignored_message_policy=observe: non-trigger messages do not invoke agent (messages already stored in DB)', async () => {
      const observeGroup: RegisteredGroup = {
        name: 'Observer',
        folder: 'observer-group',
        pattern: '@TARS',
        added_at: '2024-01-01T00:00:00.000Z',
        engage_mode: 'pattern',
        sender_scope: 'all',
        ignored_message_policy: 'observe',
      };
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'obs@g.us', content: 'just a chat message, no trigger' }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'obs@g.us': observeGroup };

      // No trigger match → agent not invoked (message already stored by channel adapter)
      const result = await orch.processGroupMessages('obs@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).not.toHaveBeenCalled();
    });

    it('ignored_message_policy=observe: trigger messages DO invoke agent', async () => {
      const observeGroup: RegisteredGroup = {
        name: 'Observer',
        folder: 'observer-group',
        pattern: '@TARS',
        added_at: '2024-01-01T00:00:00.000Z',
        engage_mode: 'pattern',
        sender_scope: 'all',
        ignored_message_policy: 'observe',
      };
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'obs@g.us', content: '@TARS process this' }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'obs@g.us': observeGroup };

      const result = await orch.processGroupMessages('obs@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).toHaveBeenCalled();
    });

    it('ignored_message_policy=drop (default): non-trigger messages silently skipped', async () => {
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sec@g.us', content: 'no trigger here' }),
        ]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'sec@g.us': secondaryGroup }; // ignored_message_policy: 'drop'

      const result = await orch.processGroupMessages('sec@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).not.toHaveBeenCalled();
    });

    it('sender_scope=known is a no-op until Phase 4 — engages with engage_mode=always regardless', async () => {
      // sender_scope='known' is reserved for Phase 4 (where channel adapters would
      // filter to known senders). Until then it must be ignored so no messages are
      // silently dropped just because the user_dms cache doesn't exist yet.
      const knownScopeGroup: RegisteredGroup = {
        name: 'Known Scope Group',
        folder: 'known-scope',
        pattern: '^!',
        added_at: '2024-01-01T00:00:00.000Z',
        engage_mode: 'always',
        sender_scope: 'known',
        ignored_message_policy: 'drop',
      };
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          // Message from a sender NOT in any user_dms cache
          makeMessage({ chat_jid: 'known@g.us', content: 'hello, no trigger needed', sender: 'unknown-sender@s' }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = { 'known@g.us': knownScopeGroup };

      // sender_scope='known' must be ignored today — engage_mode=always should fire
      const result = await orch.processGroupMessages('known@g.us');
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

  describe('unregistered sender recording', () => {
    it('calls recordUnregisteredSender for messages from unknown JIDs (not is_from_me)', async () => {
      const dbEvents = new EventEmitter();
      const recordUnregisteredSender = vi.fn();
      const deps = makeDeps({
        dbEvents,
        pollInterval: 60000,
        recordUnregisteredSender,
        getNewMessages: vi.fn(() => ({
          messages: [
            makeMessage({
              id: 'unregd-1',
              chat_jid: 'unknown@s.whatsapp.net',
              sender: 'stranger@s.whatsapp.net',
              sender_name: 'Stranger',
              is_from_me: false,
            }),
          ],
          newTimestamp: '2024-01-01T00:00:02.000Z',
        })),
      });
      // No registered group for 'unknown@s.whatsapp.net'
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = {};
      orch.channels = [{ name: 'whatsapp', ownsJid: (jid) => jid.endsWith('.net'), isConnected: () => true } as any];

      const loopPromise = orch.startMessageLoop();
      await new Promise((r) => setTimeout(r, 50));
      orch.stop();
      await loopPromise;

      expect(recordUnregisteredSender).toHaveBeenCalledWith(
        'whatsapp',
        'unknown@s.whatsapp.net',
        'Stranger',
      );
    });

    it('does NOT call recordUnregisteredSender for is_from_me messages', async () => {
      const dbEvents = new EventEmitter();
      const recordUnregisteredSender = vi.fn();
      const deps = makeDeps({
        dbEvents,
        pollInterval: 60000,
        recordUnregisteredSender,
        getNewMessages: vi.fn(() => ({
          messages: [
            makeMessage({
              id: 'self-1',
              chat_jid: 'unknown@s.whatsapp.net',
              sender: 'me@s.whatsapp.net',
              sender_name: 'Me',
              is_from_me: true,
            }),
          ],
          newTimestamp: '2024-01-01T00:00:02.000Z',
        })),
      });
      const orch = new MessageOrchestrator(deps);
      orch.registeredGroups = {};
      orch.channels = [{ name: 'whatsapp', ownsJid: (jid) => jid.endsWith('.net'), isConnected: () => true } as any];

      const loopPromise = orch.startMessageLoop();
      await new Promise((r) => setTimeout(r, 50));
      orch.stop();
      await loopPromise;

      expect(recordUnregisteredSender).not.toHaveBeenCalled();
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
