export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanotars/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)

  // --- Phase 5B: per-agent-group image build ---
  /**
   * Per-group apt + npm packages, layered on top of `nanoclaw-agent:latest`
   * by `buildAgentGroupImage`. Populated by `install_packages` self-mod.
   */
  packages?: { apt: string[]; npm: string[] };
  /**
   * Project-relative paths to per-group Dockerfile.partial fragments. Stack
   * on top of the base image (which already has plugin partials baked in).
   * HOST-MANAGED: agents cannot mutate this via self-mod. Only an operator
   * with file-system access can edit container_config.dockerfilePartials.
   */
  dockerfilePartials?: string[];
  /**
   * Populated by buildAgentGroupImage. When unset, runtime falls back to
   * CONTAINER_IMAGE (i.e., the shared base nanoclaw-agent:latest).
   */
  imageTag?: string | null;
  /**
   * Phase 5C: agent-installable MCP servers. Read at agent-runner startup;
   * merged with plugin-provided MCP fragments.
   */
  mcpServers?: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

export type EngageMode = 'pattern' | 'always' | 'mention-sticky';
export type SenderScope = 'all' | 'known';
export type IgnoredMessagePolicy = 'drop' | 'observe';

// --- Phase 4A entity model ---
//
// The legacy registered_groups table splits into:
//   agent_groups          — the bot-side identity (folder, container config)
//   messaging_groups      — the chat-side identity (channel + platform_id)
//   messaging_group_agents — wiring between the two (engage rules)
//
// A7 (this file) removed the legacy `RegisteredGroup` interface entirely.
// New code consumes `AgentGroup` / `MessagingGroup` / `MessagingGroupAgent`
// directly via the entity-model accessors in src/db/agent-groups.ts.

export interface AgentGroup {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  container_config: string | null; // JSON-serialized; consumers parse on read
  created_at: string;
}

export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string | null;
  is_group: number; // 0 | 1
  unknown_sender_policy: 'strict' | 'request_approval' | 'public';
  created_at: string;
}

export interface MessagingGroupAgent {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: 'pattern' | 'always' | 'mention-sticky';
  engage_pattern: string | null;
  sender_scope: 'all' | 'known';
  ignored_message_policy: 'drop' | 'observe';
  session_mode: string | null;
  priority: number;
  created_at: string;
}

// --- Phase 4B RBAC entities ---
//
// Identity + privilege live in the central DB. `users` is the canonical
// identity (composite id "<channel>:<handle>"); `user_roles` records owner /
// admin grants (global when agent_group_id is NULL, scoped otherwise);
// `agent_group_members` is the unprivileged access gate; `user_dms` caches
// the DM messaging-group resolution per (user, channel) pair so cold-DM
// lookups don't re-resolve every time.

export interface User {
  id: string;
  kind: string;
  display_name: string | null;
  created_at: string;
}

export interface UserRole {
  user_id: string;
  role: 'owner' | 'admin';
  agent_group_id: string | null;
  granted_by: string | null;
  granted_at: string;
}

export interface AgentGroupMember {
  user_id: string;
  agent_group_id: string;
  added_by: string | null;
  added_at: string;
}

export interface UserDm {
  user_id: string;
  channel_type: string;
  messaging_group_id: string;
  resolved_at: string;
}

export interface ReplyContext {
  sender_name: string;
  text: string | null; // null = non-text message (photo, sticker, etc.)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  /** Media type hint: 'image', 'video', 'audio', 'document' */
  mediaType?: string;
  /** Container-relative path for media (e.g., /workspace/group/media/xyz.ogg) */
  mediaPath?: string;
  /** Absolute host path where media file was saved (for host-side hooks) */
  mediaHostPath?: string;
  /** Context about the message being replied to, if this is a reply */
  reply_context?: ReplyContext;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  model?: string | null;
  script?: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, sender?: string, replyTo?: string): Promise<void>;
  /**
   * Optional hook: transform outbound text immediately before delivery.
   *
   * Called after secret redaction and the `<internal>`-tag strip, but before
   * `sendMessage`. Useful for per-channel sanitization (e.g., escaping
   * Telegram-Markdown reserved characters, WhatsApp emoji prefixes).
   * If the channel does not implement this hook, the text is passed through
   * unchanged. Returning an empty string is allowed and suppresses delivery.
   */
  transformOutboundText?(text: string, jid: string): string | Promise<string>;
  /**
   * Optional: resolve a user handle (e.g., '@alice', 'alice', 'tg:1234567')
   * to a chat JID that subsequent sendMessage calls can target.
   *
   * Throws if the handle cannot be resolved (e.g., user does not exist,
   * channel does not support DM resolution from a handle, or privacy
   * settings prevent it). Channels that don't support cold-DM resolution
   * should leave this method undefined.
   *
   * Higher-level callers (e.g., the Phase 4 ensureUserDm wrapper) translate
   * throws to null at their policy layer rather than forcing every channel
   * implementation to do so.
   */
  openDM?(handle: string): Promise<string>;
  /**
   * Optional: extract reply context from a channel-platform-native raw message.
   *
   * Returns the normalized ReplyContext if the message is a reply, or null
   * otherwise. Receives the raw platform message (Baileys WAMessage, Telegram
   * update payload, etc.); the channel knows how to interpret its own format.
   *
   * If the hook is undefined, the inbound flow uses whatever reply_context
   * the channel itself populated on the NewMessage object during message
   * delivery. Hook callers run during inbound processing — see future
   * router-side wiring for the integration point.
   */
  extractReplyContext?(rawMessage: unknown): ReplyContext | null;
  sendFile?(jid: string, buffer: Buffer, mime: string, fileName: string, caption?: string): Promise<void>;
  react?(jid: string, messageId: string, emoji: string, participant?: string, fromMe?: boolean): Promise<void>;
  /**
   * Optional: surface "the bot is doing something" presence to the chat,
   * e.g. Telegram's `sendChatAction('typing')` or WhatsApp presence updates.
   *
   * Channels that don't natively support an activity indicator should leave
   * this undefined — the orchestrator's call site is best-effort. The hook
   * is single-shot; on platforms where the indicator fades on a fixed timer
   * (Telegram: ~5s), the orchestrator may re-call to keep it alive while
   * an agent run is in flight.
   */
  setTyping?(jid: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  refreshMetadata?(): Promise<void>;
  listAvailableGroups?(): Promise<Array<{ jid: string; name: string }>>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void | Promise<void>;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
export type OnChatMetadata = (chatJid: string, timestamp: string, name?: string) => void;
