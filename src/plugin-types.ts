import type { Logger } from 'pino';
import type { Channel, NewMessage, OnInboundMessage, OnChatMetadata, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';
import type { ChatInfo } from './db.js';

/** Plugin manifest (plugin.json) */
export interface PluginManifest {
  name: string;
  description?: string;
  /** Env var names from .env to pass into agent containers */
  containerEnvVars?: string[];
  /** Env vars whose values are safe to appear in outbound messages (exempt from secret redaction) */
  publicEnvVars?: string[];
  /** Hook functions this plugin exports */
  hooks?: string[];
  /** JS files to load as SDK hooks inside agent containers (paths relative to plugin dir) */
  containerHooks?: string[];
  /** Additional read-only mounts for agent containers (host paths resolved at load time) */
  containerMounts?: Array<{ hostPath: string; containerPath: string }>;
  /** Whether this plugin has its own package.json/node_modules */
  dependencies?: boolean;
  /** True if this plugin provides a channel (e.g. WhatsApp, Discord) */
  channelPlugin?: boolean;
  /** Skill name for interactive auth setup (e.g. "setup-whatsapp", "add-channel-discord") */
  authSkill?: string;
  /** Which channel types this plugin applies to. Default: ["*"] (all) */
  channels?: string[];
  /** Which group folders get this plugin's container injection. Default: ["*"] (all) */
  groups?: string[];
  /** Plugin version (semver, e.g. "1.0.0") */
  version?: string;
  /** Minimum NanoClaw core version required (semver, e.g. "1.0.0") */
  minCoreVersion?: string;
}

/** Message passed through onInboundMessage hooks */
export type InboundMessage = NewMessage;

/** Config passed to channel plugins so they can feed messages into core */
export interface ChannelPluginConfig {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Project paths and config values channels may need */
  paths: {
    storeDir: string;
    groupsDir: string;
    channelsDir: string;
  };
  /** Config values */
  assistantName: string;
  assistantHasOwnNumber: boolean;
  /** DB helpers for group metadata sync */
  db: {
    getLastGroupSync(): string | null;
    setLastGroupSync(): void;
    updateChatName(jid: string, name: string): void;
  };
}

/** API surface available to plugins */
export interface PluginContext {
  insertMessage(chatJid: string, id: string, sender: string, senderName: string, text: string): void;
  sendMessage(jid: string, text: string): Promise<void>;
  getRegisteredGroups(): Record<string, RegisteredGroup>;
  getMainChannelJid(): string | null;
  logger: Logger;

  /** All known chats ordered by recent activity */
  getAllChats(): ChatInfo[];
  /** Active session IDs keyed by group folder */
  getSessions(): Record<string, string>;
  /** Queue status: active containers, per-group state */
  getQueueStatus(): { activeCount: number; groups: Array<{ jid: string; folder: string; active: boolean; pendingMessages: boolean; pendingTaskCount: number; retryCount: number }> };
  /** Connected channel status */
  getChannelStatus(): Array<{ name: string; connected: boolean }>;

  /** Installed plugin metadata */
  getInstalledPlugins(): Array<{ name: string; description?: string; version?: string; channelPlugin: boolean; groups?: string[]; channels?: string[]; dir: string }>;

  /** Task CRUD (delegates to db.ts) */
  getAllTasks(): ScheduledTask[];
  getTaskById(id: string): ScheduledTask | undefined;
  getTasksForGroup(folder: string): ScheduledTask[];
  createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void;
  updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status' | 'model'>>): void;
  deleteTask(id: string): void;
  getTaskRunLogs(taskId: string, limit?: number): TaskRunLog[];

  /** Recent messages for a chat */
  getRecentMessages(jid: string, limit?: number): NewMessage[];
}

/** Hook functions a plugin can export */
export interface PluginHooks {
  onStartup?(ctx: PluginContext): Promise<void>;
  onShutdown?(): Promise<void>;
  onInboundMessage?(msg: InboundMessage, channel: string): Promise<InboundMessage>;
  onOutboundMessage?(text: string, jid: string, channel: string): Promise<string>;
  onChannel?(ctx: PluginContext, config: ChannelPluginConfig): Promise<Channel>;
}

/** A loaded plugin instance */
export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  hooks: PluginHooks;
}
