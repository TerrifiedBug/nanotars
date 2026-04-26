import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

import { MessageOrchestrator, OrchestratorDeps } from '../orchestrator.js';
import type { Channel, NewMessage } from '../types.js';
import {
  _initTestDatabase,
  createAgentGroup,
  createMessagingGroup,
  createWiring,
} from '../db/index.js';
import { ensureUser } from '../permissions/users.js';
import { grantRole } from '../permissions/user-roles.js';
import { addMember } from '../permissions/agent-group-members.js';
import { ensureUserDm } from '../permissions/user-dms.js';
import { resolveSender } from '../permissions/sender-resolver.js';
import {
  getPendingSenderApproval,
  hasInFlightSenderApproval,
} from '../permissions/sender-approval.js';
import { clearApprovalHandlers } from '../permissions/approval-primitive.js';

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

/**
 * Phase 4B note: orchestrator's routing path admits everyone under the
 * default `sender_scope='all'`; admin gating happens elsewhere
 * (command-gate.ts). Tests that exercise the strict `sender_scope='known'`
 * path seed users + roles + memberships explicitly. Existing routing /
 * engage_mode / trigger tests therefore need no RBAC setup.
 */
const DEFAULT_USER_ID = 'whatsapp:user@s';

beforeEach(() => {
  _initTestDatabase();
  clearApprovalHandlers();
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

      // A7: the legacy `registeredGroups` getter is gone. Public state is
      // exposed via getAgentGroups() (entity-model AgentGroup[]) and
      // getJidFolderMap() (per-JID folder lookups for IPC auth).
      const map = orch.getJidFolderMap();
      expect(map['main@g.us']).toBeDefined();
      expect(map['main@g.us'].folder).toBe('main');
      const ags = orch.getAgentGroups();
      expect(ags.find((a) => a.folder === 'main')).toBeDefined();
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

      // The new entity-model lookup should resolve this entry.
      const map = orch.getJidFolderMap();
      expect(map['new@g.us']).toBeDefined();
      expect(map['new@g.us'].folder).toBe('new-folder');
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
      // Wirings ARE deduped: the (messaging_group_id, agent_group_id) UNIQUE
      // constraint is enforced and addAgentForChat returns the existing wiring
      // when one already matches the pair.
      expect(second.wiring.id).toBe(first.wiring.id);
      const map = orch.getJidFolderMap();
      expect(map['shared@g.us']).toBeDefined();
    });
  });

  describe('public agent-group accessors (A7 successor to registeredGroups)', () => {
    it('getAgentGroups returns the entity-model AgentGroup rows', () => {
      seedAgent({
        ...mainSeed,
        container_config: '{"timeout":1000}',
      });
      const deps = makeDeps();
      const orch = new MessageOrchestrator(deps);

      const ags = orch.getAgentGroups();
      const main = ags.find((a) => a.folder === 'main');
      expect(main).toBeDefined();
      expect(main!.name).toBe('Main Chat');
      expect(main!.container_config).toBe('{"timeout":1000}');
    });

    it('getJidFolderMap collapses multi-wiring to first by priority and warns', () => {
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
      const map = orch.getJidFolderMap();

      // Lossy collapse: only one folder is exposed for the JID.
      expect(map['multi@g.us']).toBeDefined();
      expect(['agent-a', 'agent-b']).toContain(map['multi@g.us'].folder);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'multi@g.us' }),
        expect.stringContaining('routing picking first by priority'),
      );
    });
  });

  describe('Phase 4B: real RBAC + sender-scope gate', () => {
    // Phase 4A anchored the orchestrator to call resolveSender +
    // canAccessAgentGroup; Phase 4B replaced the stubs with real
    // implementations and made the sender_scope wiring column the
    // governing knob. The describe block below covers both dispatch
    // sites (processGroupMessages, startMessageLoop) under the four
    // matrix cells: { sender_scope: 'all' | 'known' } x
    // { user: non-member | member-or-admin }.

    describe('processGroupMessages', () => {
      it('sender_scope=all: non-member is dispatched (admin gating happens elsewhere)', async () => {
        seedAgent({ ...mainSeed, sender_scope: 'all' });
        const deps = makeDeps({
          getMessagesSince: vi.fn(() => [
            makeMessage({
              timestamp: '2024-01-01T00:00:05.000Z',
              sender: 'stranger@s',
              sender_name: 'Stranger',
            }),
          ]),
        });
        const orch = new MessageOrchestrator(deps);
        orch.setChannels([mockWhatsAppChannel()]);

        await orch.processGroupMessages('main@g.us');
        expect(deps.runContainerAgent).toHaveBeenCalled();
      });

      it('sender_scope=known: non-member is dropped with debug log', async () => {
        seedAgent({
          jid: 'strict@g.us',
          name: 'Strict',
          folder: 'strict',
          pattern: '@TARS',
          engage_mode: 'always',
          sender_scope: 'known',
        });
        const deps = makeDeps({
          getMessagesSince: vi.fn(() => [
            makeMessage({
              chat_jid: 'strict@g.us',
              timestamp: '2024-01-01T00:00:05.000Z',
              sender: 'stranger@s',
            }),
          ]),
          mainGroupFolder: 'other-main',
        });
        const orch = new MessageOrchestrator(deps);
        orch.setChannels([mockWhatsAppChannel()]);

        const result = await orch.processGroupMessages('strict@g.us');
        expect(result).toBe(true);
        expect(deps.runContainerAgent).not.toHaveBeenCalled();
        expect(deps.logger.debug).toHaveBeenCalledWith(
          expect.objectContaining({ folder: 'strict' }),
          expect.stringContaining('sender_scope=known'),
        );
      });

      it('sender_scope=known: explicit member is dispatched', async () => {
        const ag = createAgentGroup({ name: 'Strict2', folder: 'strict-2' });
        const mg = createMessagingGroup({
          channel_type: 'whatsapp',
          platform_id: 'strict2@g.us',
          name: 'Strict2',
        });
        createWiring({
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: 'always',
          sender_scope: 'known',
        });
        ensureUser({ id: 'whatsapp:member@s', kind: 'whatsapp' });
        addMember({ user_id: 'whatsapp:member@s', agent_group_id: ag.id });

        const deps = makeDeps({
          getMessagesSince: vi.fn(() => [
            makeMessage({
              chat_jid: 'strict2@g.us',
              sender: 'member@s',
              timestamp: '2024-01-01T00:00:05.000Z',
            }),
          ]),
          mainGroupFolder: 'other-main',
        });
        const orch = new MessageOrchestrator(deps);
        orch.setChannels([mockWhatsAppChannel()]);

        await orch.processGroupMessages('strict2@g.us');
        expect(deps.runContainerAgent).toHaveBeenCalled();
      });

      it('sender_scope=known: global admin is dispatched (implicit member)', async () => {
        const ag = createAgentGroup({ name: 'Strict3', folder: 'strict-3' });
        const mg = createMessagingGroup({
          channel_type: 'whatsapp',
          platform_id: 'strict3@g.us',
          name: 'Strict3',
        });
        createWiring({
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: 'always',
          sender_scope: 'known',
        });
        ensureUser({ id: 'whatsapp:admin@s', kind: 'whatsapp' });
        grantRole({ user_id: 'whatsapp:admin@s', role: 'admin' }); // global admin

        const deps = makeDeps({
          getMessagesSince: vi.fn(() => [
            makeMessage({
              chat_jid: 'strict3@g.us',
              sender: 'admin@s',
              timestamp: '2024-01-01T00:00:05.000Z',
            }),
          ]),
          mainGroupFolder: 'other-main',
        });
        const orch = new MessageOrchestrator(deps);
        orch.setChannels([mockWhatsAppChannel()]);

        await orch.processGroupMessages('strict3@g.us');
        expect(deps.runContainerAgent).toHaveBeenCalled();
      });

      it('sender_scope=known: scoped admin is dispatched (implicit member)', async () => {
        const ag = createAgentGroup({ name: 'Strict4', folder: 'strict-4' });
        const mg = createMessagingGroup({
          channel_type: 'whatsapp',
          platform_id: 'strict4@g.us',
          name: 'Strict4',
        });
        createWiring({
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: 'always',
          sender_scope: 'known',
        });
        ensureUser({ id: 'whatsapp:scoped-admin@s', kind: 'whatsapp' });
        grantRole({ user_id: 'whatsapp:scoped-admin@s', role: 'admin', agent_group_id: ag.id }); // scoped admin

        const deps = makeDeps({
          getMessagesSince: vi.fn(() => [
            makeMessage({
              chat_jid: 'strict4@g.us',
              sender: 'scoped-admin@s',
              timestamp: '2024-01-01T00:00:05.000Z',
            }),
          ]),
          mainGroupFolder: 'other-main',
        });
        const orch = new MessageOrchestrator(deps);
        orch.setChannels([mockWhatsAppChannel()]);

        await orch.processGroupMessages('strict4@g.us');
        expect(deps.runContainerAgent).toHaveBeenCalled();
      });

      it('resolveSender lazily creates the users row for unknown senders', async () => {
        seedAgent(mainSeed);
        const deps = makeDeps({
          getMessagesSince: vi.fn(() => [
            makeMessage({
              timestamp: '2024-01-01T00:00:05.000Z',
              sender: 'first-time@s',
              sender_name: 'First Time',
            }),
          ]),
        });
        const orch = new MessageOrchestrator(deps);
        orch.setChannels([mockWhatsAppChannel()]);

        await orch.processGroupMessages('main@g.us');
        // The resolver-created user is queryable.
        const { getUserById } = await import('../permissions/users.js');
        const u = getUserById('whatsapp:first-time@s');
        expect(u).toBeDefined();
        expect(u!.kind).toBe('whatsapp');
        expect(u!.display_name).toBe('First Time');
      });
    });

    describe('startMessageLoop', () => {
      it('sender_scope=all: non-member is dispatched (piped to running session)', async () => {
        seedAgent({ ...mainSeed, sender_scope: 'all' });
        const dbEvents = new EventEmitter();
        const enqueueMessageCheck = vi.fn();
        const deps = makeDeps({
          dbEvents,
          pollInterval: 60000,
          getNewMessages: vi.fn(() => ({
            messages: [
              makeMessage({
                id: 'm-all',
                chat_jid: 'main@g.us',
                sender: 'stranger@s',
                timestamp: '2024-01-01T00:00:02.000Z',
              }),
            ],
            newTimestamp: '2024-01-01T00:00:02.000Z',
          })),
          queue: {
            enqueueMessageCheck,
            sendMessage: vi.fn(() => false),
            closeStdin: vi.fn(),
            registerProcess: vi.fn(),
          } as any,
        });
        const orch = new MessageOrchestrator(deps);
        orch.channels = [mockWhatsAppChannel()];

        const loopPromise = orch.startMessageLoop();
        await new Promise((r) => setTimeout(r, 50));
        orch.stop();
        await loopPromise;

        expect(enqueueMessageCheck).toHaveBeenCalledWith('main@g.us');
      });

      it('sender_scope=known: non-member does not enqueue or pipe', async () => {
        seedAgent({
          jid: 'strict-loop@g.us',
          name: 'StrictLoop',
          folder: 'strict-loop',
          pattern: '@TARS',
          engage_mode: 'always',
          sender_scope: 'known',
        });
        const dbEvents = new EventEmitter();
        const sendMessage = vi.fn(() => false);
        const enqueueMessageCheck = vi.fn();
        const deps = makeDeps({
          dbEvents,
          pollInterval: 60000,
          mainGroupFolder: 'other-main',
          getNewMessages: vi.fn(() => ({
            messages: [
              makeMessage({
                id: 'm-strict',
                chat_jid: 'strict-loop@g.us',
                sender: 'stranger@s',
                timestamp: '2024-01-01T00:00:02.000Z',
              }),
            ],
            newTimestamp: '2024-01-01T00:00:02.000Z',
          })),
          queue: {
            enqueueMessageCheck,
            sendMessage,
            closeStdin: vi.fn(),
            registerProcess: vi.fn(),
          } as any,
        });
        const orch = new MessageOrchestrator(deps);
        orch.channels = [mockWhatsAppChannel()];

        const loopPromise = orch.startMessageLoop();
        await new Promise((r) => setTimeout(r, 50));
        orch.stop();
        await loopPromise;

        expect(sendMessage).not.toHaveBeenCalled();
        expect(enqueueMessageCheck).not.toHaveBeenCalled();
      });

      it('sender_scope=known: explicit member is enqueued', async () => {
        const ag = createAgentGroup({ name: 'StrictLoop2', folder: 'strict-loop-2' });
        const mg = createMessagingGroup({
          channel_type: 'whatsapp',
          platform_id: 'strict-loop2@g.us',
          name: 'StrictLoop2',
        });
        createWiring({
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: 'always',
          sender_scope: 'known',
        });
        ensureUser({ id: 'whatsapp:loop-member@s', kind: 'whatsapp' });
        addMember({ user_id: 'whatsapp:loop-member@s', agent_group_id: ag.id });

        const dbEvents = new EventEmitter();
        const enqueueMessageCheck = vi.fn();
        const deps = makeDeps({
          dbEvents,
          pollInterval: 60000,
          mainGroupFolder: 'other-main',
          getNewMessages: vi.fn(() => ({
            messages: [
              makeMessage({
                id: 'm-loop-member',
                chat_jid: 'strict-loop2@g.us',
                sender: 'loop-member@s',
                timestamp: '2024-01-01T00:00:02.000Z',
              }),
            ],
            newTimestamp: '2024-01-01T00:00:02.000Z',
          })),
          queue: {
            enqueueMessageCheck,
            sendMessage: vi.fn(() => false),
            closeStdin: vi.fn(),
            registerProcess: vi.fn(),
          } as any,
        });
        const orch = new MessageOrchestrator(deps);
        orch.channels = [mockWhatsAppChannel()];

        const loopPromise = orch.startMessageLoop();
        await new Promise((r) => setTimeout(r, 50));
        orch.stop();
        await loopPromise;

        expect(enqueueMessageCheck).toHaveBeenCalledWith('strict-loop2@g.us');
      });

      it('sender_scope=known: global admin is enqueued (implicit member)', async () => {
        const ag = createAgentGroup({ name: 'StrictLoop3', folder: 'strict-loop-3' });
        const mg = createMessagingGroup({
          channel_type: 'whatsapp',
          platform_id: 'strict-loop3@g.us',
          name: 'StrictLoop3',
        });
        createWiring({
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: 'always',
          sender_scope: 'known',
        });
        ensureUser({ id: 'whatsapp:loop-global-admin@s', kind: 'whatsapp' });
        grantRole({ user_id: 'whatsapp:loop-global-admin@s', role: 'admin' }); // global admin

        const dbEvents = new EventEmitter();
        const enqueueMessageCheck = vi.fn();
        const deps = makeDeps({
          dbEvents,
          pollInterval: 60000,
          mainGroupFolder: 'other-main',
          getNewMessages: vi.fn(() => ({
            messages: [
              makeMessage({
                id: 'm-loop-global-admin',
                chat_jid: 'strict-loop3@g.us',
                sender: 'loop-global-admin@s',
                timestamp: '2024-01-01T00:00:02.000Z',
              }),
            ],
            newTimestamp: '2024-01-01T00:00:02.000Z',
          })),
          queue: {
            enqueueMessageCheck,
            sendMessage: vi.fn(() => false),
            closeStdin: vi.fn(),
            registerProcess: vi.fn(),
          } as any,
        });
        const orch = new MessageOrchestrator(deps);
        orch.channels = [mockWhatsAppChannel()];

        const loopPromise = orch.startMessageLoop();
        await new Promise((r) => setTimeout(r, 50));
        orch.stop();
        await loopPromise;

        expect(enqueueMessageCheck).toHaveBeenCalledWith('strict-loop3@g.us');
      });

      it('sender_scope=known: scoped admin is enqueued (implicit member)', async () => {
        const ag = createAgentGroup({ name: 'StrictLoop4', folder: 'strict-loop-4' });
        const mg = createMessagingGroup({
          channel_type: 'whatsapp',
          platform_id: 'strict-loop4@g.us',
          name: 'StrictLoop4',
        });
        createWiring({
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: 'always',
          sender_scope: 'known',
        });
        ensureUser({ id: 'whatsapp:loop-scoped-admin@s', kind: 'whatsapp' });
        grantRole({ user_id: 'whatsapp:loop-scoped-admin@s', role: 'admin', agent_group_id: ag.id }); // scoped admin

        const dbEvents = new EventEmitter();
        const enqueueMessageCheck = vi.fn();
        const deps = makeDeps({
          dbEvents,
          pollInterval: 60000,
          mainGroupFolder: 'other-main',
          getNewMessages: vi.fn(() => ({
            messages: [
              makeMessage({
                id: 'm-loop-scoped-admin',
                chat_jid: 'strict-loop4@g.us',
                sender: 'loop-scoped-admin@s',
                timestamp: '2024-01-01T00:00:02.000Z',
              }),
            ],
            newTimestamp: '2024-01-01T00:00:02.000Z',
          })),
          queue: {
            enqueueMessageCheck,
            sendMessage: vi.fn(() => false),
            closeStdin: vi.fn(),
            registerProcess: vi.fn(),
          } as any,
        });
        const orch = new MessageOrchestrator(deps);
        orch.channels = [mockWhatsAppChannel()];

        const loopPromise = orch.startMessageLoop();
        await new Promise((r) => setTimeout(r, 50));
        orch.stop();
        await loopPromise;

        expect(enqueueMessageCheck).toHaveBeenCalledWith('strict-loop4@g.us');
      });
    });

    it('resolveSender keying matches DEFAULT_USER_ID convention', () => {
      expect(resolveSender({
        channel: 'whatsapp',
        platform_id: 'group@s.whatsapp.net',
        sender_handle: 'user@s',
      })).toBe(DEFAULT_USER_ID);
    });
  });

  describe('Phase 4D D2: pending-sender approval flow', () => {
    // The processGroupMessages and startMessageLoop gates each issue a
    // requestSenderApproval when a sender_scope='known' wiring denies a
    // not-a-member sender. We verify that:
    //   1. The pending_sender_approvals row is created (one DB write per
    //      unknown sender), and
    //   2. The message is still dropped — no agent dispatch.
    //
    // These tests seed an owner + DM so 4C's pickApprover finds someone;
    // without that, requestSenderApproval short-circuits with a warn log
    // and never writes the cross-reference row.

    async function seedOwner(): Promise<void> {
      ensureUser({ id: 'whatsapp:owner', kind: 'whatsapp' });
      grantRole({ user_id: 'whatsapp:owner', role: 'owner' });
      await ensureUserDm({ user_id: 'whatsapp:owner', channel_type: 'whatsapp' });
    }

    it('processGroupMessages: known-scope + not-a-member triggers requestSenderApproval', async () => {
      await seedOwner();
      const ag = createAgentGroup({ name: 'Strict', folder: 'strict-d2' });
      const mg = createMessagingGroup({
        channel_type: 'whatsapp',
        platform_id: 'd2@g.us',
        name: 'D2',
      });
      createWiring({
        messaging_group_id: mg.id,
        agent_group_id: ag.id,
        engage_mode: 'always',
        sender_scope: 'known',
      });

      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({
            chat_jid: 'd2@g.us',
            sender: 'stranger@s',
            sender_name: 'Stranger',
            content: 'please let me in',
            timestamp: '2024-01-01T00:00:05.000Z',
          }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      const result = await orch.processGroupMessages('d2@g.us');
      expect(result).toBe(true);
      // Message dropped — agent never dispatched.
      expect(deps.runContainerAgent).not.toHaveBeenCalled();

      // Wait long enough for the fire-and-forget requestSenderApproval to
      // settle — pickApprovalDelivery is async (touches user_dms) and
      // requestApproval persists synchronously after.
      await new Promise((r) => setTimeout(r, 150));

      // Cross-reference row materialized for the unknown sender.
      expect(hasInFlightSenderApproval(mg.id, 'whatsapp:stranger@s')).toBe(true);
      const psa = getPendingSenderApproval({
        messaging_group_id: mg.id,
        sender_identity: 'whatsapp:stranger@s',
      });
      expect(psa?.agent_group_id).toBe(ag.id);
      expect(psa?.original_message).toBe('please let me in');
    });

    it('processGroupMessages: a member is admitted (no approval written)', async () => {
      await seedOwner();
      const ag = createAgentGroup({ name: 'Strict', folder: 'strict-d2-member' });
      const mg = createMessagingGroup({
        channel_type: 'whatsapp',
        platform_id: 'd2-mem@g.us',
        name: 'D2-mem',
      });
      createWiring({
        messaging_group_id: mg.id,
        agent_group_id: ag.id,
        engage_mode: 'always',
        sender_scope: 'known',
      });
      ensureUser({ id: 'whatsapp:bob@s', kind: 'whatsapp' });
      addMember({ user_id: 'whatsapp:bob@s', agent_group_id: ag.id });

      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({
            chat_jid: 'd2-mem@g.us',
            sender: 'bob@s',
            timestamp: '2024-01-01T00:00:05.000Z',
          }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      await orch.processGroupMessages('d2-mem@g.us');
      // Member admitted — agent dispatched, no approval row.
      expect(deps.runContainerAgent).toHaveBeenCalled();
      expect(hasInFlightSenderApproval(mg.id, 'whatsapp:bob@s')).toBe(false);
    });

    it('processGroupMessages: idempotent — second drop does not double-write the row', async () => {
      await seedOwner();
      const ag = createAgentGroup({ name: 'Strict', folder: 'strict-d2-idem' });
      const mg = createMessagingGroup({
        channel_type: 'whatsapp',
        platform_id: 'd2-idem@g.us',
        name: 'D2-idem',
      });
      createWiring({
        messaging_group_id: mg.id,
        agent_group_id: ag.id,
        engage_mode: 'always',
        sender_scope: 'known',
      });

      const deps = makeDeps({
        getMessagesSince: vi.fn(() => [
          makeMessage({
            chat_jid: 'd2-idem@g.us',
            sender: 'spammer@s',
            sender_name: 'Spammer',
            timestamp: '2024-01-01T00:00:05.000Z',
          }),
        ]),
        mainGroupFolder: 'other-main',
      });
      const orch = new MessageOrchestrator(deps);
      orch.setChannels([mockWhatsAppChannel()]);

      await orch.processGroupMessages('d2-idem@g.us');
      await new Promise((r) => setTimeout(r, 150));
      await orch.processGroupMessages('d2-idem@g.us');
      await new Promise((r) => setTimeout(r, 150));

      // UNIQUE constraint guarantees exactly one row across the two drops.
      const { getDb } = await import('../db/init.js');
      const n = (getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM pending_sender_approvals WHERE messaging_group_id = ? AND sender_identity = ?`,
        )
        .get(mg.id, 'whatsapp:spammer@s') as { n: number }).n;
      expect(n).toBe(1);
    });
  });

  describe('Phase 4D D3: pending-channel approval flow', () => {
    // When startMessageLoop sees inbound messages on a chat with no
    // messaging_group_agents wiring (allRegistered[chatJid] is undefined),
    // it now calls requestChannelApproval in addition to the legacy
    // recordUnregisteredSender bookkeeping. The call is fire-and-forget;
    // these tests assert the pending_channel_approvals row materializes.
    //
    // Seeding requires:
    //   - at least one agent_group (otherwise requestChannelApproval
    //     short-circuits with "no agent groups configured"), and
    //   - an owner with a DM (otherwise pickApprovalDelivery returns
    //     undefined and the 4D row is not written).

    async function seedOwnerAndAgent(): Promise<void> {
      ensureUser({ id: 'whatsapp:owner', kind: 'whatsapp' });
      grantRole({ user_id: 'whatsapp:owner', role: 'owner' });
      await ensureUserDm({ user_id: 'whatsapp:owner', channel_type: 'whatsapp' });
      createAgentGroup({ name: 'Existing', folder: 'existing-d3' });
    }

    it('startMessageLoop: unwired channel triggers requestChannelApproval', async () => {
      await seedOwnerAndAgent();

      const dbEvents = new EventEmitter();
      const deps = makeDeps({
        dbEvents,
        pollInterval: 60000,
        getNewMessages: vi.fn(() => ({
          messages: [
            makeMessage({
              id: 'd3-1',
              chat_jid: 'unwired@g.us',
              sender: 'stranger@s.whatsapp.net',
              sender_name: 'Stranger',
              is_from_me: false,
              timestamp: '2024-01-01T00:00:02.000Z',
            }),
          ],
          newTimestamp: '2024-01-01T00:00:02.000Z',
        })),
      });
      const orch = new MessageOrchestrator(deps);
      orch.channels = [mockWhatsAppChannel()];

      const loopPromise = orch.startMessageLoop();
      // Wait long enough for the fire-and-forget requestChannelApproval to
      // settle — pickApprovalDelivery is async (touches user_dms) and
      // requestApproval persists synchronously after.
      await new Promise((r) => setTimeout(r, 80));
      orch.stop();
      await loopPromise;

      // Pending row was written for the unwired chat.
      const { getMessagingGroup } = await import('../db/agent-groups.js');
      const { getPendingChannelApproval } = await import('../permissions/channel-approval.js');
      const mg = getMessagingGroup('whatsapp', 'unwired@g.us');
      expect(mg).toBeDefined();
      const row = getPendingChannelApproval(mg!.id);
      expect(row).toBeDefined();
      expect(row!.approver_user_id).toBe('whatsapp:owner');

      // Legacy diagnostic write still happens — the new branch added the
      // approval call without removing recordUnregisteredSender.
      expect(deps.recordUnregisteredSender).toHaveBeenCalledWith(
        'whatsapp',
        'unwired@g.us',
        'Stranger',
      );
    });

    it('D6: original message_text flows from orchestrator → pending_channel_approvals', async () => {
      await seedOwnerAndAgent();

      const dbEvents = new EventEmitter();
      const deps = makeDeps({
        dbEvents,
        pollInterval: 60000,
        getNewMessages: vi.fn(() => ({
          messages: [
            makeMessage({
              id: 'd6-1',
              chat_jid: 'unwired-d6@g.us',
              sender: 'stranger@s.whatsapp.net',
              sender_name: 'Stranger',
              is_from_me: false,
              content: 'first ever message',
              timestamp: '2024-01-01T00:00:02.000Z',
            }),
          ],
          newTimestamp: '2024-01-01T00:00:02.000Z',
        })),
      });
      const orch = new MessageOrchestrator(deps);
      orch.channels = [mockWhatsAppChannel()];

      const loopPromise = orch.startMessageLoop();
      await new Promise((r) => setTimeout(r, 80));
      orch.stop();
      await loopPromise;

      const { getMessagingGroup } = await import('../db/agent-groups.js');
      const { getPendingChannelApproval } = await import('../permissions/channel-approval.js');
      const mg = getMessagingGroup('whatsapp', 'unwired-d6@g.us');
      expect(mg).toBeDefined();
      const row = getPendingChannelApproval(mg!.id);
      expect(row).toBeDefined();

      // D6: original_message JSON now includes message_text so the
      // approval handler can replay it through the registered hook.
      const parsed = JSON.parse(row!.original_message) as { message_text?: string };
      expect(parsed.message_text).toBe('first ever message');
    });

    it('startMessageLoop: is_from_me messages do not trigger an approval card', async () => {
      await seedOwnerAndAgent();

      const dbEvents = new EventEmitter();
      const deps = makeDeps({
        dbEvents,
        pollInterval: 60000,
        getNewMessages: vi.fn(() => ({
          messages: [
            makeMessage({
              id: 'd3-self',
              chat_jid: 'unwired-self@g.us',
              sender: 'me@s.whatsapp.net',
              sender_name: 'Me',
              is_from_me: true,
              timestamp: '2024-01-01T00:00:02.000Z',
            }),
          ],
          newTimestamp: '2024-01-01T00:00:02.000Z',
        })),
      });
      const orch = new MessageOrchestrator(deps);
      orch.channels = [mockWhatsAppChannel()];

      const loopPromise = orch.startMessageLoop();
      await new Promise((r) => setTimeout(r, 80));
      orch.stop();
      await loopPromise;

      // No pending row — only externalMessages (filter !is_from_me) drive
      // the approval flow.
      const { getMessagingGroup } = await import('../db/agent-groups.js');
      const mg = getMessagingGroup('whatsapp', 'unwired-self@g.us');
      // The messaging_group might not even be created if the branch never
      // runs requestChannelApproval. Either way, no pending row.
      if (mg) {
        const { getPendingChannelApproval } = await import('../permissions/channel-approval.js');
        expect(getPendingChannelApproval(mg.id)).toBeUndefined();
      }
    });
  });
});
