import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MessageOrchestrator, OrchestratorDeps } from '../orchestrator.js';
import type { Channel, NewMessage, RegisteredGroup } from '../types.js';
import {
  _initTestDatabase,
  createAgentGroup,
  createMessagingGroup,
  createWiring,
} from '../db/index.js';

/**
 * Test helper: seed a (channel, jid, folder) tuple into the new entity-model
 * tables. Mirrors the legacy `setRegisteredGroup` shape so individual tests
 * stay terse.
 */
function seedAgent(opts: {
  channel?: string;
  jid: string;
  name: string;
  folder: string;
  pattern?: string;
  engage_mode?: 'pattern' | 'always' | 'mention-sticky';
  sender_scope?: 'all' | 'known';
  ignored_message_policy?: 'drop' | 'observe';
  container_config?: string | null;
}): void {
  const ag = createAgentGroup({
    name: opts.name,
    folder: opts.folder,
    container_config: opts.container_config ?? null,
  });
  const mg = createMessagingGroup({
    channel_type: opts.channel ?? 'whatsapp',
    platform_id: opts.jid,
    name: opts.name,
  });
  createWiring({
    messaging_group_id: mg.id,
    agent_group_id: ag.id,
    engage_mode: opts.engage_mode ?? 'pattern',
    engage_pattern: opts.pattern ?? null,
    sender_scope: opts.sender_scope ?? 'all',
    ignored_message_policy: opts.ignored_message_policy ?? 'drop',
  });
}

function mockWhatsAppChannel(): Channel {
  return {
    name: 'whatsapp',
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsJid: (jid: string) =>
      jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net') || jid.endsWith('.net'),
    disconnect: async () => {},
  };
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    getRouterState: vi.fn(() => undefined),
    setRouterState: vi.fn(),
    recordUnregisteredSender: vi.fn(),
    getAllSessions: vi.fn(() => ({})),
    setSession: vi.fn(),
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

const mainSeed = {
  jid: 'main@g.us',
  name: 'Main Chat',
  folder: 'main',
  pattern: '@TARS',
  engage_mode: 'always' as const,
  sender_scope: 'all' as const,
  ignored_message_policy: 'drop' as const,
};

const secondarySeed = {
  jid: 'sec@g.us',
  name: 'Secondary',
  folder: 'secondary',
  pattern: '@TARS',
  engage_mode: 'pattern' as const,
  sender_scope: 'all' as const,
  ignored_message_policy: 'drop' as const,
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

beforeEach(() => {
  _initTestDatabase();
});

describe('MessageOrchestrator', () => {
  describe('loadState', () => {
    it('loads state from DB', () => {
      seedAgent(mainSeed);
      const deps = makeDeps({
        getRouterState: vi.fn((key) => {
          if (key === 'last_timestamp') return '2024-01-01T00:00:00.000Z';
          if (key === 'last_agent_timestamp')
            return '{"main@g.us":"2024-01-01T00:00:00.000Z"}';
          return undefined;
        }),
        getAllSessions: vi.fn(() => ({ main: 'sess-1' })),
      });
      const orch = new MessageOrchestrator(deps);
      orch.loadState();

      // registeredGroups is now a synthesized getter sourced from new tables.
      expect(orch.registeredGroups['main@g.us']).toBeDefined();
      expect(orch.registeredGroups['main@g.us'].folder).toBe('main');
      expect(orch.registeredGroups['main@g.us'].engage_mode).toBe('always');
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
      seedAgent(mainSeed);
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ timestamp: '2024-01-01T00:00:05.000Z' }),
        ]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);
      orch.loadState();

      const result = await orch.processGroupMessages('main@g.us');
      expect(result).toBe(true);
      // State was saved (cursor advanced)
      expect(deps.setRouterState).toHaveBeenCalled();
    });

    it('rolls back cursor on error', async () => {
      seedAgent(mainSeed);
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
      orch.setChannels([mockWhatsAppChannel()]);

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
      seedAgent(mainSeed);
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
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('main@g.us');
      // Should return true (don't roll back) because output was already sent
      expect(result).toBe(true);
    });

    it('advances cursor after MAX_CONSECUTIVE_ERRORS', async () => {
      seedAgent(mainSeed);
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
      orch.setChannels([mockWhatsAppChannel()]);

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
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('unknown@g.us');
      expect(result).toBe(true);
    });

    it('returns true when no messages pending', async () => {
      seedAgent(mainSeed);
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => []),
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('main@g.us');
      expect(result).toBe(true);
    });
  });

  describe('trigger pattern', () => {
    it('main group skips trigger check', async () => {
      seedAgent(mainSeed);
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ content: 'no trigger here' }),
        ]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('main@g.us');
      // Should process (not skip) even without trigger
      expect(result).toBe(true);
      expect(deps.runContainerAgent).toHaveBeenCalled();
    });

    it('non-main group requires trigger', async () => {
      seedAgent(secondarySeed);
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sec@g.us', content: 'no trigger' }),
        ]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('sec@g.us');
      // Should skip processing — no trigger
      expect(result).toBe(true);
      expect(deps.runContainerAgent).not.toHaveBeenCalled();
    });

    it('non-main group processes with trigger present', async () => {
      seedAgent(secondarySeed);
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sec@g.us', content: '@TARS hello' }),
        ]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('sec@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).toHaveBeenCalled();
    });
  });

  describe('engage_mode semantics (processGroupMessages)', () => {
    it('engage_mode=always engages on every message regardless of pattern match', async () => {
      seedAgent({
        jid: 'always@g.us',
        name: 'Always',
        folder: 'always-group',
        pattern: '@TARS',
        engage_mode: 'always',
      });
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'always@g.us', content: 'no trigger at all' }),
        ]),
        mainGroupFolder: 'other-main', // so always-group is not the main group
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('always@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).toHaveBeenCalled();
    });

    it('engage_mode=pattern only engages on pattern-matching messages', async () => {
      seedAgent(secondarySeed);
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sec@g.us', content: 'no trigger here' }),
        ]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('sec@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).not.toHaveBeenCalled();
    });

    it('engage_mode=mention-sticky (Phase 4 forward-compat) currently treated as pattern', async () => {
      seedAgent({
        jid: 'sticky@g.us',
        name: 'Sticky',
        folder: 'sticky-group',
        pattern: '@TARS',
        engage_mode: 'mention-sticky',
      });
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sticky@g.us', content: 'no trigger here' }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      // Without trigger: should NOT engage (behaves as pattern mode)
      const result = await orch.processGroupMessages('sticky@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).not.toHaveBeenCalled();
    });

    it('engage_mode=mention-sticky engages when trigger pattern matches', async () => {
      seedAgent({
        jid: 'sticky@g.us',
        name: 'Sticky',
        folder: 'sticky-group',
        pattern: '@TARS',
        engage_mode: 'mention-sticky',
      });
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sticky@g.us', content: '@TARS hello' }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('sticky@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).toHaveBeenCalled();
    });

    it('ignored_message_policy=observe: non-trigger messages do not invoke agent (messages already stored in DB)', async () => {
      seedAgent({
        jid: 'obs@g.us',
        name: 'Observer',
        folder: 'observer-group',
        pattern: '@TARS',
        engage_mode: 'pattern',
        sender_scope: 'all',
        ignored_message_policy: 'observe',
      });
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'obs@g.us', content: 'just a chat message, no trigger' }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      // No trigger match → agent not invoked (message already stored by channel adapter)
      const result = await orch.processGroupMessages('obs@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).not.toHaveBeenCalled();
    });

    it('ignored_message_policy=observe: trigger messages DO invoke agent', async () => {
      seedAgent({
        jid: 'obs@g.us',
        name: 'Observer',
        folder: 'observer-group',
        pattern: '@TARS',
        engage_mode: 'pattern',
        sender_scope: 'all',
        ignored_message_policy: 'observe',
      });
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'obs@g.us', content: '@TARS process this' }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('obs@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).toHaveBeenCalled();
    });

    it('ignored_message_policy=drop (default): non-trigger messages silently skipped', async () => {
      seedAgent(secondarySeed);
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({ chat_jid: 'sec@g.us', content: 'no trigger here' }),
        ]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('sec@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).not.toHaveBeenCalled();
    });

    it('sender_scope=known is a no-op until Phase 4 — engages with engage_mode=always regardless', async () => {
      // sender_scope='known' is reserved for Phase 4 (where channel adapters would
      // filter to known senders). Until then it must be ignored so no messages are
      // silently dropped just because the user_dms cache doesn't exist yet.
      seedAgent({
        jid: 'known@g.us',
        name: 'Known Scope Group',
        folder: 'known-scope',
        pattern: '^!',
        engage_mode: 'always',
        sender_scope: 'known',
      });
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({
            chat_jid: 'known@g.us',
            content: 'hello, no trigger needed',
            sender: 'unknown-sender@s',
          }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('known@g.us');
      expect(result).toBe(true);
      expect(deps.runContainerAgent).toHaveBeenCalled();
    });
  });

  describe('recoverPendingMessages', () => {
    it('enqueues groups with pending messages', () => {
      seedAgent(mainSeed);
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [makeMessage()]),
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      orch.recoverPendingMessages();
      expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith('main@g.us');
    });

    it('skips groups with no pending messages', () => {
      seedAgent(mainSeed);
      const deps = makeDeps({
        getMessagesSince: vi.fn(() => []),
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

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
      // No registered group for 'unknown@s.whatsapp.net' (DB is empty)
      const orch = new MessageOrchestrator(deps);
      orch.channels = [mockWhatsAppChannel()];

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
      orch.channels = [mockWhatsAppChannel()];

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

  describe('addAgentForChat', () => {
    it('creates messaging_group + agent_group + wiring rows', () => {
      const deps = makeDeps();
      const orch = new MessageOrchestrator(deps);
      const result = orch.addAgentForChat({
        channel: 'whatsapp',
        platformId: 'new@g.us',
        name: 'New',
        folder: 'new-folder',
        engage_mode: 'pattern',
        pattern: '\\bhi\\b',
      });
      expect(result.agentGroup.folder).toBe('new-folder');
      expect(result.messagingGroup.platform_id).toBe('new@g.us');
      expect(result.wiring.engage_pattern).toBe('\\bhi\\b');

      // The synthesized registeredGroups should now include this entry.
      expect(orch.registeredGroups['new@g.us']).toBeDefined();
      expect(orch.registeredGroups['new@g.us'].folder).toBe('new-folder');
    });

    it('reuses existing messaging_group and agent_group across repeated calls', () => {
      const deps = makeDeps();
      const orch = new MessageOrchestrator(deps);
      const first = orch.addAgentForChat({
        channel: 'whatsapp',
        platformId: 'shared@g.us',
        name: 'Shared',
        folder: 'shared-folder',
      });
      const second = orch.addAgentForChat({
        channel: 'whatsapp',
        platformId: 'shared@g.us',
        name: 'Shared',
        folder: 'shared-folder',
      });
      expect(second.agentGroup.id).toBe(first.agentGroup.id);
      expect(second.messagingGroup.id).toBe(first.messagingGroup.id);
      // Wirings are not deduped today — addAgentForChat creates a new wiring row.
      // The synthesized shim picks the first wiring per JID with a warning.
      expect(orch.registeredGroups['shared@g.us']).toBeDefined();
    });
  });

  describe('synthesized registeredGroups (legacy-compat shim)', () => {
    it('returns the legacy shape from new entity-model tables', () => {
      seedAgent({
        ...mainSeed,
        container_config: '{"timeout":1000}',
      });
      const deps = makeDeps();
      const orch = new MessageOrchestrator(deps);

      const groups = orch.getRegisteredGroups();
      expect(groups['main@g.us']).toBeDefined();
      const g: RegisteredGroup = groups['main@g.us'];
      expect(g.folder).toBe('main');
      expect(g.name).toBe('Main Chat');
      expect(g.engage_mode).toBe('always');
      expect(g.sender_scope).toBe('all');
      expect(g.ignored_message_policy).toBe('drop');
      expect(g.channel).toBe('whatsapp');
      expect(g.containerConfig).toEqual({ timeout: 1000 });
    });

    it('logs warning and picks first wiring when multiple agents wire the same chat', () => {
      // Manually create a multi-agent wiring on a single messaging group.
      const ag1 = createAgentGroup({ name: 'A', folder: 'agent-a' });
      const ag2 = createAgentGroup({ name: 'B', folder: 'agent-b' });
      const mg = createMessagingGroup({
        channel_type: 'whatsapp',
        platform_id: 'multi@g.us',
        name: 'Multi',
      });
      createWiring({ messaging_group_id: mg.id, agent_group_id: ag1.id });
      createWiring({ messaging_group_id: mg.id, agent_group_id: ag2.id });

      const deps = makeDeps();
      const orch = new MessageOrchestrator(deps);
      const groups = orch.getRegisteredGroups();

      // Lossy collapse: only one wiring is exposed via the legacy shape.
      expect(groups['multi@g.us']).toBeDefined();
      expect(['agent-a', 'agent-b']).toContain(groups['multi@g.us'].folder);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'multi@g.us' }),
        expect.stringContaining('legacy registeredGroups shim'),
      );
    });
  });
});
