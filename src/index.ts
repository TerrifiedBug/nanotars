import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  CHANNELS_DIR,
  createTriggerPattern,
  DATA_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  STORE_DIR,
} from './config.js';
import { ensureRunning as ensureContainerRuntime } from './container-runtime.js';
import {
  mapTasksToSnapshot,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  dbEvents,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastGroupSync,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setLastGroupSync,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  insertExternalMessage,
  updateChatName,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, routeOutbound, stripInternalTags } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { logger } from './logger.js';
import { loadPlugins, PluginRegistry } from './plugin-loader.js';
import { setPluginRegistry } from './container-runner.js';
import { MessageOrchestrator } from './orchestrator.js';
import type { ChannelPluginConfig, PluginContext } from './plugin-types.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

const queue = new GroupQueue();
let plugins: PluginRegistry;

async function main(): Promise<void> {
  ensureContainerRuntime();
  initDatabase();
  logger.info('Database initialized');

  const orchestrator = new MessageOrchestrator({
    getRouterState,
    setRouterState,
    getAllSessions,
    setSession,
    getAllRegisteredGroups,
    setRegisteredGroup,
    getMessagesSince,
    getNewMessages,
    getAllChats,
    getAllTasks,
    formatMessages,
    routeOutbound,
    stripInternalTags,
    createTriggerPattern,
    runContainerAgent,
    mapTasksToSnapshot,
    writeTasksSnapshot,
    writeGroupsSnapshot,
    queue,
    assistantName: ASSISTANT_NAME,
    mainGroupFolder: MAIN_GROUP_FOLDER,
    pollInterval: POLL_INTERVAL,
    groupsDir: GROUPS_DIR,
    dataDir: DATA_DIR,
    dbEvents,
    logger,
  });

  orchestrator.loadState();

  // Load plugins (env vars, hooks, channels, MCP configs)
  plugins = await loadPlugins();
  setPluginRegistry(plugins);

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await plugins.shutdown();
    await queue.shutdown(10000);
    for (const ch of orchestrator.channels) {
      await ch.disconnect();
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create pluginCtx first — channels array populated later but closure captures reference
  const pluginCtx: PluginContext = {
    insertMessage: insertExternalMessage,
    sendMessage: (jid, text) => routeOutbound(orchestrator.channels, jid, text).then(() => {}),
    getRegisteredGroups: () => orchestrator.registeredGroups,
    getMainChannelJid: () => {
      const mainEntry = Object.entries(orchestrator.registeredGroups).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      );
      return mainEntry ? mainEntry[0] : null;
    },
    logger,
  };

  // Initialize channel plugins
  const channels = [];
  for (const plugin of plugins.getChannelPlugins()) {
    const channelConfig: ChannelPluginConfig = {
      onMessage: async (chatJid, msg) => {
        const transformed = await plugins.runInboundHooks(msg, plugin.manifest.name);
        storeMessage(transformed);
      },
      onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
      registeredGroups: () => orchestrator.registeredGroups,
      paths: {
        storeDir: STORE_DIR,
        groupsDir: GROUPS_DIR,
        channelsDir: CHANNELS_DIR,
      },
      assistantName: ASSISTANT_NAME,
      assistantHasOwnNumber: ASSISTANT_HAS_OWN_NUMBER,
      db: {
        getLastGroupSync,
        setLastGroupSync,
        updateChatName,
      },
    };
    const channel = await plugin.hooks.onChannel!(pluginCtx, channelConfig);
    channels.push(channel);
    await channel.connect();
    logger.info({ channel: channel.name }, 'Channel connected');
  }
  orchestrator.setChannels(channels);

  if (channels.length === 0) {
    logger.warn('No channel plugins loaded — NanoClaw will not receive messages');
  }

  // Warn about registered groups with no connected channel
  for (const [jid, group] of Object.entries(orchestrator.registeredGroups)) {
    if (!channels.some(ch => ch.ownsJid(jid))) {
      logger.warn({ jid, group: group.name }, 'Registered group has no connected channel');
    }
  }

  // Start non-channel plugins
  await plugins.startup(pluginCtx);

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => orchestrator.registeredGroups,
    getSessions: () => orchestrator.sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = stripInternalTags(rawText);
      if (text) await routeOutbound(orchestrator.channels, jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, sender) => routeOutbound(orchestrator.channels, jid, text, sender).then(() => {}),
    registeredGroups: () => orchestrator.registeredGroups,
    registerGroup: (jid, group) => orchestrator.registerGroup(jid, group),
    syncGroupMetadata: async (_force) => {
      for (const ch of orchestrator.channels) {
        if (ch.refreshMetadata) await ch.refreshMetadata();
      }
    },
    getAvailableGroups: () => orchestrator.getAvailableGroups(),
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });

  queue.setProcessMessagesFn((chatJid) => orchestrator.processGroupMessages(chatJid));
  orchestrator.recoverPendingMessages();
  orchestrator.startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
