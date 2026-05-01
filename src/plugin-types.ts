import type { Logger } from 'pino';
import type { AgentGroup, Channel, MessagingGroup, MessagingGroupAgent, NewMessage, OnInboundMessage, OnChatMetadata, ScheduledTask, TaskRunLog } from './types.js';
import type { ChatInfo } from './db.js';

/** Plugin manifest (plugin.json) */
export interface PluginManifest {
  name: string;
  description?: string;
  /** Env var names from .env to pass into agent containers */
  containerEnvVars?: string[];
  /** Env var names read by host-side plugin hooks, not passed into agent containers */
  hostEnvVars?: string[];
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
  /**
   * Phase 5A: when true, this plugin contributes a non-default agent provider
   * (Codex, OpenCode, Ollama, etc.). Plugin's index.js MUST call
   * registerProviderContainerConfig(name, fn) at top level so the registration
   * fires when the loader imports the module.
   */
  agentProvider?: boolean;
  /**
   * Phase 5A: provider name (e.g. 'codex'). Required when agentProvider is true.
   */
  agentProviderName?: string;
}

/** Message passed through onInboundMessage hooks */
export type InboundMessage = NewMessage;

/** Config passed to channel plugins so they can feed messages into core */
export interface ChannelPluginConfig {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  /**
   * Phase 4A entity-model successor to the legacy `registeredGroups`
   * Record<jid, RegisteredGroup>. Plugins now receive an array of
   * AgentGroup rows; iterate or filter as needed. For per-chat routing,
   * use `resolveAgentsForInbound` below — the chat-level lookup the old
   * `registeredGroups()[jid]` access was actually used for.
   */
  agentGroups: () => AgentGroup[];
  /**
   * Per-chat routing lookup. Returns the wiring rows (with their resolved
   * messaging_group + agent_group) for an inbound message on `(channel,
   * platformId)`. Empty array means the chat is not registered — channels
   * use this to drop unregistered chats at the inbound boundary the same
   * way they used `registeredGroups()[jid]` on the legacy schema.
   */
  resolveAgentsForInbound: (
    channel: string,
    platformId: string,
  ) => Array<{
    agentGroup: AgentGroup;
    wiring: MessagingGroupAgent;
    messagingGroup: MessagingGroup;
  }>;
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
  /**
   * Cross-channel pairing-codes primitive.
   *
   * Channel plugins call `consumePendingCode` from their inbound handler
   * BEFORE delivering a message to the agent — when the message text is
   * (or contains) a 4-digit pairing code, this short-circuits the inbound
   * path and returns `{ matched: true, intent }`. The plugin then sends
   * a confirmation back to the chat instead of forwarding to the agent.
   *
   * `createPendingCode` is the operator-facing side, used by setup flows
   * and admin slash-commands like `/pair-telegram` to allocate a code.
   *
   * Both fields are optional — channels that don't use pairing leave
   * them unwired.
   */
  createPendingCode?: (req: {
    channel: string;
    intent: string | Record<string, unknown>;
  }) => Promise<{ code: string; created_at: string; expires_at: string | null }>;
  consumePendingCode?: (req: {
    code: string;
    channel: string;
    sender?: string | null;
    /**
     * Canonical `<channel>:<handle>` identity of the sender (e.g.
     * `telegram:8236653927`, `whatsapp:14155551234`). Required for the
     * intent='main' bootstrap path to grant the first-pair user the owner
     * role and seed `user_dms`. When omitted, pairing still completes but
     * no role is seeded — operator has to /grant manually.
     */
    senderUserId?: string | null;
    platformId: string;
    isGroup?: boolean;
    name?: string | null;
    candidate?: string;
  }) => Promise<
    | {
        matched: true;
        intent: string | Record<string, unknown>;
        /**
         * Entity-model rows the host created (or already had) on this
         * pairing match. Null when registration could not complete —
         * `registration_error` carries the reason in that case so the
         * plugin can surface it instead of the default success message.
         */
        registered?: { agent_group_id: string; messaging_group_id: string } | null;
        registration_error?: string;
      }
    | { matched: false; invalidated: boolean }
  >;
}

/** API surface available to plugins */
export interface PluginContext {
  insertMessage(chatJid: string, id: string, sender: string, senderName: string, text: string): void;
  sendMessage(jid: string, text: string): Promise<void>;
  /**
   * Phase 4A entity-model successor to the legacy `getRegisteredGroups()`.
   * Returns one AgentGroup row per configured agent. Plugins that need to
   * look up a chat's wiring should use the entity-model accessors directly
   * (`resolveAgentsForInbound(channel, jid)`).
   */
  getAgentGroups(): AgentGroup[];
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
  updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status' | 'model' | 'script'>>): void;
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
