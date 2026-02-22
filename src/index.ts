import fs from 'fs';
import path from 'path';

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
  getMessageMeta,
  getTaskById,
  getTasksForGroup,
  createTask,
  updateTask,
  deleteTask,
  getTaskRunLogs,
  getRecentMessages,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, routeOutbound, routeOutboundFile, stripInternalTags } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { logger } from './logger.js';
import { loadPlugins, PluginRegistry } from './plugin-loader.js';
import { loadSecrets } from './secret-redact.js';
import { setPluginRegistry } from './container-runner.js';
import { MessageOrchestrator } from './orchestrator.js';
import type { ChannelPluginConfig, PluginContext } from './plugin-types.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

const queue = new GroupQueue();
let plugins: PluginRegistry;

/**
 * Singleton PID lock — prevents duplicate instances (e.g. npm run dev while
 * systemd service is running), which would create duplicate channel listeners.
 */
function acquirePidLock(): void {
  const lockFile = path.join(DATA_DIR, 'host.pid');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Atomic create via 'wx' flag — avoids check-then-act race between processes
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;

    // Lock file exists — check if the owning process is still alive
    const raw = fs.readFileSync(lockFile, 'utf-8').trim();
    const existingPid = parseInt(raw, 10);
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // signal 0 = alive check
        logger.error(
          { existingPid },
          'Another NanoClaw process is already running — exiting to prevent duplicate listeners',
        );
        process.exit(1);
      } catch {
        logger.warn({ existingPid }, 'Reclaiming stale PID lock from dead process');
      }
    }
    // Stale or self-owned — overwrite with our PID
    fs.writeFileSync(lockFile, String(process.pid), 'utf-8');
  }

  const removeLock = () => {
    try {
      if (fs.readFileSync(lockFile, 'utf-8').trim() === String(process.pid)) {
        fs.unlinkSync(lockFile);
      }
    } catch { /* ignore */ }
  };
  process.on('exit', removeLock);
}

async function main(): Promise<void> {
  acquirePidLock();
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
    dbEvents,
    logger,
  });

  orchestrator.loadState();

  // Load plugins (env vars, hooks, channels, MCP configs)
  plugins = await loadPlugins();
  setPluginRegistry(plugins);

  // Load secret redaction AFTER plugins so publicEnvVars are available
  loadSecrets(plugins.getPublicEnvVars());

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
    sendMessage: (jid, rawText) => {
      const text = stripInternalTags(rawText);
      if (!text) return Promise.resolve();
      return routeOutbound(orchestrator.channels, jid, text, undefined, undefined, plugins).then(() => {});
    },
    getRegisteredGroups: () => orchestrator.registeredGroups,
    getMainChannelJid: () => {
      const mainEntry = Object.entries(orchestrator.registeredGroups).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      );
      return mainEntry ? mainEntry[0] : null;
    },
    logger,

    // Monitoring
    getAllChats: () => getAllChats(),
    getSessions: () => orchestrator.sessions,
    getQueueStatus: () => queue.getStatus(),
    getChannelStatus: () => orchestrator.channels.map(c => ({
      name: c.name,
      connected: c.isConnected(),
    })),

    // Plugins
    getInstalledPlugins: () => plugins.loaded.map(p => ({
      name: p.manifest.name,
      description: p.manifest.description,
      version: p.manifest.version,
      channelPlugin: !!p.manifest.channelPlugin,
      groups: p.manifest.groups,
      channels: p.manifest.channels,
      dir: p.dir,
    })),

    // Tasks
    getAllTasks: () => getAllTasks(),
    getTaskById: (id) => getTaskById(id),
    getTasksForGroup: (folder) => getTasksForGroup(folder),
    createTask: (task) => createTask(task),
    updateTask: (id, updates) => updateTask(id, updates),
    deleteTask: (id) => deleteTask(id),
    getTaskRunLogs: (taskId, limit) => getTaskRunLogs(taskId, limit),

    // Messages
    getRecentMessages: (jid, limit) => getRecentMessages(jid, limit ?? 50),
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
    getResumePositions: () => orchestrator.resumePositions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText, sender) => {
      const text = stripInternalTags(rawText);
      if (text) await routeOutbound(orchestrator.channels, jid, text, sender, undefined, plugins);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, rawText, sender, replyTo) => {
      const text = stripInternalTags(rawText);
      if (!text) return Promise.resolve();
      return routeOutbound(orchestrator.channels, jid, text, sender, replyTo, plugins).then(() => {});
    },
    sendFile: (jid, buffer, mime, fileName, caption) => routeOutboundFile(orchestrator.channels, jid, buffer, mime, fileName, caption),
    react: async (jid, messageId, emoji) => {
      const channel = orchestrator.channels.find((c) => c.ownsJid(jid) && c.isConnected());
      if (channel?.react) {
        const meta = getMessageMeta(messageId, jid);
        await channel.react(jid, messageId, emoji, meta?.sender, meta?.isFromMe);
      } else {
        logger.warn({ jid }, 'No connected channel with react support for JID');
      }
    },
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
