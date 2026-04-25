import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getTaskById,
} from '../../db.js';
import {
  createAgentGroup,
  createMessagingGroup,
  createWiring,
  getAgentGroupByFolder,
  getMessagingGroup,
  resolveAgentsForInbound,
} from '../../db/agent-groups.js';
import { ensureUser } from '../../permissions/users.js';
import { grantRole } from '../../permissions/user-roles.js';
import { isAuthorizedAdminOp } from '../auth.js';
import { processTaskIpc, IpcDeps } from '../index.js';
import type {
  ContainerConfig,
  EngageMode,
  IgnoredMessagePolicy,
  SenderScope,
} from '../../types.js';

/**
 * Local test fixture shape — mirrors the v1 RegisteredGroup interface that
 * was retired in A7. Tests still seed/lookup-by JID, so this is a convenient
 * test-only carrier; production code uses the entity-model rows directly.
 */
interface TestGroupFixture {
  name: string;
  folder: string;
  pattern: string;
  added_at: string;
  channel?: string;
  containerConfig?: ContainerConfig;
  engage_mode: EngageMode;
  sender_scope: SenderScope;
  ignored_message_policy: IgnoredMessagePolicy;
}

/**
 * Seed a chat -> agent wiring through the new entity-model accessors so
 * tests exercise the same write path the orchestrator uses (via
 * addAgentForChat / registerGroup), instead of going around it through
 * the legacy registered_groups table.
 */
function seedWiring(args: {
  jid: string;
  channel: string;
  group: TestGroupFixture;
}): void {
  let mg = getMessagingGroup(args.channel, args.jid);
  if (!mg) {
    mg = createMessagingGroup({
      channel_type: args.channel,
      platform_id: args.jid,
      name: args.group.name,
    });
  }
  let ag = getAgentGroupByFolder(args.group.folder);
  if (!ag) {
    ag = createAgentGroup({
      name: args.group.name,
      folder: args.group.folder,
      container_config: args.group.containerConfig
        ? JSON.stringify(args.group.containerConfig)
        : null,
    });
  }
  createWiring({
    messaging_group_id: mg.id,
    agent_group_id: ag.id,
    engage_mode: args.group.engage_mode,
    engage_pattern: args.group.pattern || null,
    sender_scope: args.group.sender_scope,
    ignored_message_policy: args.group.ignored_message_policy,
  });
}

/** Resolve a registered chat by JID via the new entity-model accessors. */
function lookupGroupByJid(channel: string, jid: string): { folder: string } | undefined {
  const matches = resolveAgentsForInbound(channel, jid);
  if (matches.length === 0) return undefined;
  return { folder: matches[0].agentGroup.folder };
}

// Set up registered groups used across tests
const MAIN_GROUP: TestGroupFixture = {
  name: 'Main',
  folder: 'main',
  pattern: '@TARS',
  added_at: '2024-01-01T00:00:00.000Z',
  engage_mode: 'always',
  sender_scope: 'all',
  ignored_message_policy: 'drop',
};

const OTHER_GROUP: TestGroupFixture = {
  name: 'Other',
  folder: 'other-group',
  pattern: '@TARS',
  added_at: '2024-01-01T00:00:00.000Z',
  engage_mode: 'pattern',
  sender_scope: 'all',
  ignored_message_policy: 'drop',
};

const THIRD_GROUP: TestGroupFixture = {
  name: 'Third',
  folder: 'third-group',
  pattern: '@TARS',
  added_at: '2024-01-01T00:00:00.000Z',
  engage_mode: 'pattern',
  sender_scope: 'all',
  ignored_message_policy: 'drop',
};

let groups: Record<string, TestGroupFixture>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Seed via the new entity-model accessors (agent_groups + messaging_groups
  // + wiring) — the same write path orchestrator.addAgentForChat uses.
  seedWiring({ jid: 'main@g.us', channel: 'whatsapp', group: MAIN_GROUP });
  seedWiring({ jid: 'other@g.us', channel: 'whatsapp', group: OTHER_GROUP });
  seedWiring({ jid: 'third@g.us', channel: 'whatsapp', group: THIRD_GROUP });

  deps = {
    sendMessage: async () => {},
    sendFile: async () => false,
    react: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      // Capture the fixture in the test-side map so subsequent IPC handlers
      // see the registration. group already matches TestGroupFixture's
      // structural shape (RegisterGroupArgs is a strict superset minus
      // channel which we accept as optional here).
      groups[jid] = group as TestGroupFixture;
      // Mirror orchestrator.registerGroup's compound write through the new
      // entity-model accessors. Tests pass `channel` on the
      // RegisterGroupArgs payload (or default to whatsapp here) so
      // resolveAgentsForInbound can look up the result by (channel, jid).
      seedWiring({ jid, channel: group.channel ?? 'whatsapp', group: group as TestGroupFixture });
    },
    syncGroupMetadata: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'unknown@g.us',
      },
      'main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc({ type: 'pause_task', taskId: 'task-other' }, 'main', true, deps);
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc({ type: 'pause_task', taskId: 'task-other' }, 'other-group', false, deps);
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc({ type: 'pause_task', taskId: 'task-main' }, 'other-group', false, deps);
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc({ type: 'resume_task', taskId: 'task-paused' }, 'main', true, deps);
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc({ type: 'resume_task', taskId: 'task-paused' }, 'other-group', false, deps);
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc({ type: 'resume_task', taskId: 'task-paused' }, 'third-group', false, deps);
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc({ type: 'cancel_task', taskId: 'task-to-cancel' }, 'main', true, deps);
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc({ type: 'cancel_task', taskId: 'task-own' }, 'other-group', false, deps);
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc({ type: 'cancel_task', taskId: 'task-foreign' }, 'other-group', false, deps);
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        pattern: '@TARS',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc({ type: 'refresh_groups' }, 'other-group', false, deps);
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, TestGroupFixture>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(isMessageAuthorized('main', true, 'other@g.us', groups)).toBe(true);
    expect(isMessageAuthorized('main', true, 'third@g.us', groups)).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(isMessageAuthorized('other-group', false, 'other@g.us', groups)).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(false);
    expect(isMessageAuthorized('other-group', false, 'third@g.us', groups)).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(isMessageAuthorized('other-group', false, 'unknown@g.us', groups)).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(isMessageAuthorized('main', true, 'unknown@g.us', groups)).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(Date.now() - 60000);
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

// --- register_group path traversal ---

describe('register_group path traversal', () => {
  it('rejects folder with path traversal (../)', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'evil@g.us',
        name: 'Evil Group',
        folder: '../../.ssh',
        pattern: '@TARS',
      },
      'main',
      true,
      deps,
    );

    expect(groups['evil@g.us']).toBeUndefined();
    expect(lookupGroupByJid('whatsapp', 'evil@g.us')).toBeUndefined();
  });

  it('rejects folder with slashes', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'slash@g.us',
        name: 'Slash Group',
        folder: 'foo/bar',
        pattern: '@TARS',
      },
      'main',
      true,
      deps,
    );

    expect(groups['slash@g.us']).toBeUndefined();
  });

  it('rejects folder starting with a dot', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dot@g.us',
        name: 'Dot Group',
        folder: '.hidden',
        pattern: '@TARS',
      },
      'main',
      true,
      deps,
    );

    expect(groups['dot@g.us']).toBeUndefined();
  });

  it('allows valid folder names', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'good@g.us',
        name: 'Good Group',
        folder: 'family-chat',
        pattern: '@TARS',
      },
      'main',
      true,
      deps,
    );

    expect(groups['good@g.us']).toBeDefined();
  });
});

describe('react authorization', () => {
  function isReactAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, TestGroupFixture>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can react in any group', () => {
    expect(isReactAuthorized('main', true, 'other@g.us', groups)).toBe(true);
  });

  it('non-main group can react in own chat', () => {
    expect(isReactAuthorized('other-group', false, 'other@g.us', groups)).toBe(true);
  });

  it('non-main group cannot react in another groups chat', () => {
    expect(isReactAuthorized('other-group', false, 'main@g.us', groups)).toBe(false);
  });
});

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        pattern: '@TARS',
      },
      'main',
      true,
      deps,
    );

    // Verify wiring was created via the new entity-model accessors
    const matches = resolveAgentsForInbound('whatsapp', 'new@g.us');
    expect(matches).toHaveLength(1);
    expect(matches[0].agentGroup.name).toBe('New Group');
    expect(matches[0].agentGroup.folder).toBe('new-group');
    expect(matches[0].wiring.engage_pattern).toBe('@TARS');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and pattern
      },
      'main',
      true,
      deps,
    );

    expect(lookupGroupByJid('whatsapp', 'partial@g.us')).toBeUndefined();
  });

  it('register_group forwards explicit channel field to deps.registerGroup', async () => {
    // This addresses A3-review M3: orchestrator.registerGroup throws when no
    // channel adapter claims the JID and no channel was specified. IPC clients
    // pass `channel` so the resolution doesn't depend on adapter ownsJid.
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new-discord@example',
        name: 'Discord Group',
        folder: 'discord-group',
        pattern: '!',
        channel: 'discord',
      },
      'main',
      true,
      deps,
    );

    // The deps.registerGroup mock seeds via seedWiring with the supplied
    // channel; the wiring should be discoverable under that channel.
    const matches = resolveAgentsForInbound('discord', 'new-discord@example');
    expect(matches).toHaveLength(1);
    expect(matches[0].agentGroup.folder).toBe('discord-group');
    // And NOT discoverable under whatsapp.
    expect(resolveAgentsForInbound('whatsapp', 'new-discord@example')).toHaveLength(0);
  });
});

// --- isAuthorizedAdminOp: command-gate wiring ---
//
// Phase 4B B7: isAuthorizedAdminOp is the IPC-layer bridge between the
// legacy isMain heuristic and the role-based checkCommandPermission gate.
// Full threading of userId through IPC payloads is planned for Phase 4D;
// until then the function degrades gracefully to the legacy fallback.

describe('isAuthorizedAdminOp — role-based path (userId + agentGroupId present)', () => {
  it('owner is allowed to run admin command', () => {
    const ag = createAgentGroup({ name: 'IpcAlpha', folder: 'ipc-alpha' });
    ensureUser({ id: 'telegram:owner', kind: 'telegram' });
    grantRole({ user_id: 'telegram:owner', role: 'owner' });

    const result = isAuthorizedAdminOp({
      command: '/grant alice owner',
      sourceGroup: 'ipc-alpha',
      isMain: false,
      userId: 'telegram:owner',
      agentGroupId: ag.id,
      action: 'grant',
    });
    expect(result).toBe(true);
  });

  it('global admin is allowed to run admin command', () => {
    const ag = createAgentGroup({ name: 'IpcBeta', folder: 'ipc-beta' });
    ensureUser({ id: 'telegram:gadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:gadmin', role: 'admin' }); // no agent_group_id → global

    const result = isAuthorizedAdminOp({
      command: '/revoke bob',
      sourceGroup: 'ipc-beta',
      isMain: false,
      userId: 'telegram:gadmin',
      agentGroupId: ag.id,
      action: 'revoke',
    });
    expect(result).toBe(true);
  });

  it('scoped admin for this agent_group is allowed', () => {
    const ag = createAgentGroup({ name: 'IpcGamma', folder: 'ipc-gamma' });
    ensureUser({ id: 'telegram:sadmin', kind: 'telegram' });
    grantRole({ user_id: 'telegram:sadmin', role: 'admin', agent_group_id: ag.id });

    const result = isAuthorizedAdminOp({
      command: '/list-roles',
      sourceGroup: 'ipc-gamma',
      isMain: false,
      userId: 'telegram:sadmin',
      agentGroupId: ag.id,
      action: 'list-roles',
    });
    expect(result).toBe(true);
  });

  it('plain user with no role is denied for admin command', () => {
    const ag = createAgentGroup({ name: 'IpcDelta', folder: 'ipc-delta' });
    ensureUser({ id: 'telegram:nobody', kind: 'telegram' });

    const result = isAuthorizedAdminOp({
      command: '/restart',
      sourceGroup: 'ipc-delta',
      isMain: false,
      userId: 'telegram:nobody',
      agentGroupId: ag.id,
      action: 'restart',
    });
    expect(result).toBe(false);
  });

  it('unauthenticated (userId undefined) falls back to legacy isMain check — allowed when isMain=true', () => {
    const ag = createAgentGroup({ name: 'IpcEpsilon', folder: 'ipc-epsilon' });

    const result = isAuthorizedAdminOp({
      command: '/register-group',
      sourceGroup: 'main',
      isMain: true,
      userId: undefined,
      agentGroupId: ag.id,
      action: 'register-group',
    });
    expect(result).toBe(true);
  });

  it('unauthenticated (userId undefined) falls back to legacy isMain check — denied when isMain=false', () => {
    const ag = createAgentGroup({ name: 'IpcZeta', folder: 'ipc-zeta' });

    const result = isAuthorizedAdminOp({
      command: '/register-group',
      sourceGroup: 'other-group',
      isMain: false,
      userId: undefined,
      agentGroupId: ag.id,
      action: 'register-group',
    });
    expect(result).toBe(false);
  });
});

describe('isAuthorizedAdminOp — legacy fallback path (no userId/agentGroupId)', () => {
  it('main group is allowed without userId', () => {
    const result = isAuthorizedAdminOp({
      command: '/emergency-stop',
      sourceGroup: 'main',
      isMain: true,
      action: 'emergency-stop',
    });
    expect(result).toBe(true);
  });

  it('non-main group is denied without userId', () => {
    const result = isAuthorizedAdminOp({
      command: '/emergency-stop',
      sourceGroup: 'other-group',
      isMain: false,
      action: 'emergency-stop',
    });
    expect(result).toBe(false);
  });
});
