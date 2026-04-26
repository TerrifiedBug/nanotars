/**
 * MessageOrchestrator — owns the message-loop state and processing logic.
 * Extracted from index.ts for testability.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import type {
  AgentGroup,
  Channel,
  ContainerConfig,
  EngageMode,
  IgnoredMessagePolicy,
  MessagingGroup,
  MessagingGroupAgent,
  NewMessage,
  SenderScope,
} from './types.js';
import type { RegisterGroupArgs } from './ipc/types.js';
import type { ContainerOutput } from './container-runner.js';
import type { AvailableGroup } from './snapshots.js';
import type { GroupQueue } from './group-queue.js';
import type { ScheduledTask } from './types.js';
import { isAuthError } from './router.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
  type SenderAllowlistConfig,
} from './sender-allowlist.js';
import {
  createAgentGroup,
  createMessagingGroup,
  createWiring,
  getAgentGroupByFolder,
  getAllAgentGroups,
  getAllSynthesizedGroupRows,
  getMessagingGroup,
  getWiring,
  resolveAgentsForInbound,
} from './db/agent-groups.js';
import { canAccessAgentGroup } from './permissions/access.js';
import { resolveSender, type SenderInfo } from './permissions/sender-resolver.js';
import {
  registerSenderApprovalHandler,
  requestSenderApproval,
} from './permissions/sender-approval.js';
import {
  registerChannelApprovalHandler,
  requestChannelApproval,
} from './permissions/channel-approval.js';
import { isAdminCommand } from './command-gate.js';
import { dispatchAdminCommand } from './admin-command-dispatch.js';

// TODO(phase-4d-D6): wire chat-sdk button-click events into
// `handleApprovalClick` from './permissions/approval-click-auth.js'. v1
// currently has no chat-sdk button-click flow, so the handler is unused
// outside its tests. When channel adapters start emitting click events,
// the handler signature is:
//   await handleApprovalClick({
//     approval_id,        // from button callback_data
//     clicker_user_id,    // resolveSender({channel, platform_id, sender_handle}).user.id
//     decision,           // 'approved' | 'rejected'
//   });
// Auth (approver-self vs admin-override) is fully encapsulated inside
// approval-click-auth.ts — the orchestrator should not re-check it.

/** Dependency injection interface for the orchestrator. */
export interface OrchestratorDeps {
  // DB functions
  getRouterState: (key: string) => string | undefined;
  setRouterState: (key: string, value: string) => void;
  recordUnregisteredSender: (channel: string, platformId: string, senderName: string) => void;
  getAllSessions: () => Record<string, string>;
  setSession: (groupFolder: string, sessionId: string) => void;
  getMessagesSince: (chatJid: string, since: string, botPrefix: string) => NewMessage[];
  getNewMessages: (jids: string[], lastTs: string, botPrefix: string) => { messages: NewMessage[]; newTimestamp: string };
  getAllChats: () => Array<{ jid: string; name: string; last_message_time: string }>;
  getAllTasks: () => ScheduledTask[];

  // Routing
  formatMessages: (messages: NewMessage[]) => string;
  routeOutbound: (channels: Channel[], jid: string, text: string, sender?: string, replyTo?: string, pluginRegistry?: import('./plugin-loader.js').PluginRegistry) => Promise<boolean>;
  stripInternalTags: (text: string) => string;
  createTriggerPattern: (trigger: string) => RegExp;

  // Container runner
  runContainerAgent: (
    group: AgentGroup,
    input: {
      prompt: string;
      sessionId?: string;
      resumeAt?: string;
      groupFolder: string;
      chatJid: string;
      isMain: boolean;
      // Phase 5E: optional resolved user id for the message sender, used by
      // the runner to gate `NANOCLAW_IS_ADMIN=1` for admin-only MCP tools.
      senderUserId?: string;
    },
    onProcess: (proc: import('child_process').ChildProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    channel?: string,
  ) => Promise<ContainerOutput>;
  mapTasksToSnapshot: (tasks: ScheduledTask[]) => ReturnType<typeof import('./snapshots.js').mapTasksToSnapshot>;
  writeTasksSnapshot: typeof import('./snapshots.js').writeTasksSnapshot;
  writeGroupsSnapshot: (groupFolder: string, isMain: boolean, groups: AvailableGroup[], registeredJids: Set<string>) => void;

  // Queue
  queue: GroupQueue;

  // Config
  assistantName: string;
  mainGroupFolder: string;
  pollInterval: number;
  groupsDir: string;

  // Reactions
  react?: (jid: string, messageId: string, emoji: string) => Promise<void>;

  // Events
  dbEvents: EventEmitter;

  // Logger
  logger: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
    debug: (obj: unknown, msg?: string) => void;
    fatal?: (obj: unknown, msg?: string) => void;
  };
}

const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Internal routing record: resolved (chat × agent × wiring) projection that
 * the message loop consumes. Phase 4A's A7 cleanup replaced the legacy
 * `RegisteredGroup` interface with this orchestrator-private shape so no
 * external module re-implements the legacy fields.
 */
interface ResolvedAgentRouting {
  name: string;
  folder: string;
  pattern: string;
  added_at: string;
  channel: string;
  containerConfig?: ContainerConfig;
  engage_mode: EngageMode;
  sender_scope: SenderScope;
  ignored_message_policy: IgnoredMessagePolicy;
}

export class MessageOrchestrator {
  private lastTimestamp = '';
  sessions: Record<string, string> = {};
  resumePositions: Record<string, string> = {};
  private lastAgentTimestamp: Record<string, string> = {};
  private consecutiveErrors: Record<string, number> = {};
  private processedIds = new Set<string>();
  private processedIdsTimestamp = '';
  channels: Channel[] = [];
  private messageLoopRunning = false;
  private stopRequested = false;
  private senderAllowlist: SenderAllowlistConfig;

  constructor(private deps: OrchestratorDeps) {
    this.senderAllowlist = loadSenderAllowlist();
    // Phase 4D D2: register the sender-approval handler with 4C's
    // approval primitive. Idempotent in the registry.
    registerSenderApprovalHandler();
    // Phase 4D D3: register the unknown-channel approval handler with 4C's
    // approval primitive. Idempotent in the registry, so multiple
    // orchestrator instances (tests) overwrite-but-warn rather than crash.
    registerChannelApprovalHandler();
  }

  /**
   * Build a `Record<jid, ResolvedAgentRouting>` projection from the entity
   * model. Used internally by the message loop; the multi-wiring "first
   * wins" collapse mirrors `resolveAgentsForInbound`'s ORDER BY so the
   * iteration order and the lookup order agree.
   *
   * Recomputed on every call (no cache). Multi-wiring on the same chat
   * collapses to the highest-priority wiring with a warning.
   */
  private synthesizeRouting(): Record<string, ResolvedAgentRouting> {
    const rows = getAllSynthesizedGroupRows();
    const result: Record<string, ResolvedAgentRouting> = {};
    for (const row of rows) {
      if (result[row.platform_id]) {
        // Already keyed (from a higher-priority wiring per ORDER BY); skip with warn.
        this.deps.logger.warn(
          {
            jid: row.platform_id,
            folder: row.agent_group_folder,
            existingFolder: result[row.platform_id].folder,
          },
          'Multiple wirings on same chat; routing picking first by priority',
        );
        continue;
      }
      let containerConfig: ContainerConfig | undefined;
      if (row.agent_group_container_config) {
        try {
          containerConfig = JSON.parse(row.agent_group_container_config) as ContainerConfig;
        } catch (err) {
          this.deps.logger.warn(
            { folder: row.agent_group_folder, err },
            'Failed to parse agent_groups.container_config; ignoring',
          );
        }
      }
      result[row.platform_id] = {
        name: row.agent_group_name,
        folder: row.agent_group_folder,
        pattern: row.wiring_engage_pattern ?? '',
        // The wiring's birth ("when this chat was registered for this agent"),
        // not the agent group's creation (which may have happened earlier
        // when the group was first created for a different chat).
        added_at: row.wiring_created_at,
        channel: row.channel_type,
        containerConfig,
        engage_mode: row.wiring_engage_mode as EngageMode,
        sender_scope: row.wiring_sender_scope as SenderScope,
        ignored_message_policy:
          row.wiring_ignored_message_policy as IgnoredMessagePolicy,
      };
    }
    return result;
  }

  /**
   * Resolve an inbound chat JID to its routing record, scoped to the channel
   * that owns the JID. Returns undefined when no wiring exists. If multiple
   * wirings exist (Phase 4D multi-agent), the first is returned with a
   * warning — single-agent semantics.
   */
  private resolveGroupForChat(chatJid: string): ResolvedAgentRouting | undefined {
    const channel = this.channels.find((ch) => ch.ownsJid(chatJid));
    if (!channel) return undefined;
    const resolved = resolveAgentsForInbound(channel.name, chatJid);
    if (resolved.length === 0) return undefined;
    if (resolved.length > 1) {
      this.deps.logger.warn(
        { chatJid, channel: channel.name, count: resolved.length },
        'Multi-agent wiring on chat; routing to first agent only (Phase 4D pending)',
      );
    }
    const { agentGroup: ag, wiring: w, messagingGroup: mg } = resolved[0];
    let containerConfig: ContainerConfig | undefined;
    if (ag.container_config) {
      try {
        containerConfig = JSON.parse(ag.container_config) as ContainerConfig;
      } catch (err) {
        this.deps.logger.warn(
          { folder: ag.folder, err },
          'Failed to parse agent_groups.container_config; ignoring',
        );
      }
    }
    return {
      name: ag.name,
      folder: ag.folder,
      pattern: w.engage_pattern ?? '',
      added_at: ag.created_at,
      channel: mg.channel_type,
      containerConfig,
      engage_mode: w.engage_mode,
      sender_scope: w.sender_scope,
      ignored_message_policy: w.ignored_message_policy,
    };
  }

  loadState(): void {
    this.lastTimestamp = this.deps.getRouterState('last_timestamp') || '';
    const agentTs = this.deps.getRouterState('last_agent_timestamp');
    try {
      this.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      this.deps.logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      this.lastAgentTimestamp = {};
    }
    this.sessions = this.deps.getAllSessions();
    const groupCount = Object.keys(this.synthesizeRouting()).length;
    this.deps.logger.info({ groupCount }, 'State loaded');
  }

  private saveState(): void {
    this.deps.setRouterState('last_timestamp', this.lastTimestamp);
    this.deps.setRouterState(
      'last_agent_timestamp',
      JSON.stringify(this.lastAgentTimestamp),
    );
  }

  /**
   * Compound write: ensure messaging_group + agent_group + wiring rows exist
   * for an (channel, platformId, folder) tuple. Replaces v1's single-table
   * `registered_groups` insert. Idempotent on (channel, platformId), (folder),
   * and on (mg_id, ag_id) — repeated calls reuse all three rows.
   *
   * Note: when a wiring already exists, this method returns the existing
   * wiring unchanged. To update wiring fields (engage_mode, pattern, …)
   * the caller should delete + recreate or use a future updateWiring helper.
   */
  addAgentForChat(args: {
    channel: string;
    platformId: string;
    name: string;
    folder: string;
    engage_mode?: 'pattern' | 'always' | 'mention-sticky';
    pattern?: string | null;
    sender_scope?: 'all' | 'known';
    ignored_message_policy?: 'drop' | 'observe';
    container_config?: string | null;
  }): { agentGroup: AgentGroup; messagingGroup: MessagingGroup; wiring: MessagingGroupAgent } {
    let mg = getMessagingGroup(args.channel, args.platformId);
    if (!mg) {
      mg = createMessagingGroup({
        channel_type: args.channel,
        platform_id: args.platformId,
        name: args.name,
      });
    }
    let ag = getAgentGroupByFolder(args.folder);
    if (!ag) {
      ag = createAgentGroup({
        name: args.name,
        folder: args.folder,
        container_config: args.container_config ?? null,
      });
    }
    const existing = getWiring(mg.id, ag.id);
    const wiring =
      existing ??
      createWiring({
        messaging_group_id: mg.id,
        agent_group_id: ag.id,
        engage_mode: args.engage_mode ?? 'pattern',
        engage_pattern: args.pattern ?? null,
        sender_scope: args.sender_scope ?? 'all',
        ignored_message_policy: args.ignored_message_policy ?? 'drop',
      });
    return { agentGroup: ag, messagingGroup: mg, wiring };
  }

  registerGroup(jid: string, group: RegisterGroupArgs): void {
    // Resolve channel for the JID. Prefer group.channel (set by callers that
    // know which adapter owns the JID, e.g. IPC); fall back to the connected
    // channel that owns the JID. There is no literal default — silently
    // writing 'whatsapp' on a Discord/Telegram-only install would corrupt
    // routing (subsequent resolveAgentsForInbound('discord', jid) would find
    // nothing and messages would drop with no diagnostic). Throw instead.
    const resolvedChannel =
      group.channel ?? this.channels.find((ch) => ch.ownsJid(jid))?.name;
    if (!resolvedChannel) {
      throw new Error(
        `Cannot register group ${jid}: no channel adapter claims this JID and no channel was specified. ` +
          `Connected adapters: ${this.channels.map((c) => c.name).join(', ') || '(none)'}.`,
      );
    }

    this.addAgentForChat({
      channel: resolvedChannel,
      platformId: jid,
      name: group.name,
      folder: group.folder,
      engage_mode: group.engage_mode,
      pattern: group.pattern || null,
      sender_scope: group.sender_scope,
      ignored_message_policy: group.ignored_message_policy,
      container_config: group.containerConfig
        ? JSON.stringify(group.containerConfig)
        : null,
    });

    const groupDir = path.join(this.deps.groupsDir, group.folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    this.deps.logger.info(
      { jid, name: group.name, folder: group.folder, channel: resolvedChannel },
      'Group registered',
    );
  }

  getAvailableGroups(): AvailableGroup[] {
    const chats = this.deps.getAllChats();
    const registeredJids = new Set(Object.keys(this.synthesizeRouting()));

    return chats
      .filter((c) => c.jid !== '__group_sync__' && this.channels.some(ch => ch.ownsJid(c.jid)))
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
      }));
  }

  /**
   * Public plugin/IPC accessor: list every configured agent group. Plugins
   * that need per-chat routing should call `resolveAgentsForInbound` from
   * the entity-model accessors directly.
   */
  getAgentGroups(): AgentGroup[] {
    return getAllAgentGroups();
  }

  /**
   * Per-JID folder map used for IPC authorization. Computed from the entity
   * model — the keys are the registered chat platform_ids, the values carry
   * only the agent's folder (other fields aren't needed for auth checks).
   */
  getJidFolderMap(): Record<string, { folder: string }> {
    const routing = this.synthesizeRouting();
    const map: Record<string, { folder: string }> = {};
    for (const [jid, r] of Object.entries(routing)) {
      map[jid] = { folder: r.folder };
    }
    return map;
  }

  getSessions(): Record<string, string> {
    return this.sessions;
  }

  setChannels(ch: Channel[]): void {
    this.channels = ch;
  }

  /** Stop the message loop gracefully (for testing). */
  stop(): void {
    this.stopRequested = true;
    // Emit to wake the loop so it checks stopRequested
    this.deps.dbEvents.emit('new-message', '__stop__');
  }

  /** Pause the message loop (for emergency stop). */
  pause(): void {
    this.stopRequested = true;
    this.deps.dbEvents.emit('new-message', '__pause__');
    this.deps.logger.info('Message loop paused');
  }

  /** Resume the message loop after a pause. */
  resume(): void {
    if (this.stopRequested) {
      this.stopRequested = false;
      // Wait for the old loop to fully exit before starting a new one
      const tryStart = () => {
        if (!this.messageLoopRunning) {
          this.startMessageLoop().catch((err) => {
            this.deps.logger.error({ err }, 'Failed to restart message loop');
          });
          this.deps.logger.info('Message loop resumed');
        } else {
          setTimeout(tryStart, 50);
        }
      };
      // Wake the old loop so it re-checks stopRequested and exits
      this.deps.dbEvents.emit('new-message', '__resume__');
      tryStart();
    }
  }

  async processGroupMessages(chatJid: string): Promise<boolean> {
    const group = this.resolveGroupForChat(chatJid);
    if (!group) return true;

    const isMainGroup = group.folder === this.deps.mainGroupFolder;

    const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';
    const missedMessages = this.deps.getMessagesSince(chatJid, sinceTimestamp, this.deps.assistantName);

    if (missedMessages.length === 0) return true;

    const lastTriggerMessageId = missedMessages[missedMessages.length - 1]?.id;

    // Phase 4B permissions enforcement.
    //
    // resolveSender lazily creates a users row keyed by
    // `<channel>:<sender_handle>` and always returns a userId.
    //
    // The wiring's sender_scope governs admittance:
    //   sender_scope='all'   (default) — everyone is admitted; admin-only
    //                          actions are still gated separately by
    //                          command-gate.ts.
    //   sender_scope='known' (strict)  — only owner / global-admin /
    //                          scoped-admin / explicit-member of the agent
    //                          group can interact. Anyone else is dropped.
    //
    // The strict path delegates to canAccessAgentGroup, whose decision
    // order is owner → global-admin → scoped-admin → member → deny and
    // whose returned reason gets logged so denials are debuggable.
    const channel = this.channels.find((ch) => ch.ownsJid(chatJid));
    const lastMsg = missedMessages[missedMessages.length - 1];
    const senderInfo: SenderInfo = {
      channel: channel?.name ?? group.channel ?? 'unknown',
      platform_id: chatJid,
      sender_handle: lastMsg.sender,
      sender_name: lastMsg.sender_name,
    };
    const userId = resolveSender(senderInfo);
    const agentGroupRow = getAgentGroupByFolder(group.folder);
    if (agentGroupRow && group.sender_scope === 'known') {
      const access = canAccessAgentGroup(userId, agentGroupRow.id);
      if (!access.allowed) {
        this.deps.logger.debug(
          { jid: chatJid, folder: group.folder, agentGroupId: agentGroupRow.id, userId, reason: access.reason },
          'Dropped by sender_scope=known gate',
        );
        // Phase 4D D2: when the gate denies a non-member (vs. a missing user
        // id, which is a different failure), open a pending-sender approval
        // card so an admin can grant access. The message is still dropped
        // here — replay on approve is deferred to D6.
        if (access.reason === 'not-a-member') {
          const mg = getMessagingGroup(senderInfo.channel, chatJid);
          if (mg) {
            void requestSenderApproval({
              user_id: userId,
              agent_group_id: agentGroupRow.id,
              agent_group_folder: agentGroupRow.folder,
              messaging_group_id: mg.id,
              sender_identity: userId,
              display_name: senderInfo.sender_name ?? undefined,
              message_text: lastMsg.content,
              originating_channel: senderInfo.channel,
            }).catch((err) =>
              this.deps.logger.warn({ err }, 'requestSenderApproval failed'),
            );
          }
        }
        return true;
      }
    }

    // For non-main groups, check if trigger is required and present
    // engage_mode='always' skips the trigger check entirely.
    // engage_mode='pattern' and 'mention-sticky' (Phase 4 forward-compat) require a trigger.
    if (!isMainGroup && group.engage_mode !== 'always') {
      const pattern = this.deps.createTriggerPattern(group.pattern);
      const hasTrigger = missedMessages.some((m) =>
        pattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, this.senderAllowlist)),
      );
      // Also trigger on replies to the bot's messages
      const hasReplyToBot = missedMessages.some((m) =>
        m.reply_context?.sender_name === this.deps.assistantName,
      );
      if (!hasTrigger && !hasReplyToBot) return true;
    }

    // Slice 5: admin-command dispatch. If the trigger message is an admin
    // slash-command and this is a single-message batch, run the host-side
    // handler chain. Multi-message batches (rare in practice) still go to
    // the agent — splitting them adds complexity without operator value.
    if (missedMessages.length === 1 && agentGroupRow) {
      const trigger = missedMessages[0];
      const tokens = trigger.content.trim().split(/\s+/);
      const command = tokens[0];
      if (isAdminCommand(command)) {
        const result = await dispatchAdminCommand({
          command,
          args: tokens.slice(1),
          rest: trigger.content.slice(command.length).trim() || undefined,
          userId,
          agentGroupId: agentGroupRow.id,
          userHandle: trigger.sender_name ?? trigger.sender,
        });
        if (result.handled) {
          if (result.reply && channel?.sendMessage) {
            try {
              await channel.sendMessage(chatJid, result.reply);
            } catch (err) {
              this.deps.logger.warn(
                { err, chatJid, command },
                'Admin command reply send failed',
              );
            }
          }
          // Mark trigger as processed so we don't redispatch on the next sweep.
          this.lastAgentTimestamp[chatJid] = trigger.timestamp;
          this.deps.logger.info(
            { chatJid, command, permissionReason: result.permissionReason },
            'Admin command handled host-side',
          );
          return true;
        }
      }
    }

    const prompt = this.deps.formatMessages(missedMessages);

    // Advance cursor so the piping path won't re-fetch these messages.
    const previousCursor = this.lastAgentTimestamp[chatJid] || '';
    this.lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    this.saveState();

    this.deps.logger.info(
      { group: group.name, messageCount: missedMessages.length },
      'Processing messages',
    );

    // Track idle timer for closing stdin when agent is idle
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    // Dynamic import keeps IDLE_TIMEOUT out of OrchestratorDeps
    const { IDLE_TIMEOUT } = await import('./config.js');

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        this.deps.logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
        this.deps.queue.closeStdin(chatJid);
      }, IDLE_TIMEOUT);
    };

    // Acknowledge receipt with reaction
    if (lastTriggerMessageId && this.deps.react) {
      this.deps.react(chatJid, lastTriggerMessageId, '\u{1F440}').catch(() => {});
    }

    let hadError = false;
    let outputSentToUser = false;
    let authErrorNotified = false;
    let firstOutputSent = false;

    const output = await this.runAgent(group, prompt, chatJid, userId, async (result) => {
      if (result.status === 'error') {
        hadError = true;

        // Auth errors get immediate user notification regardless of prior output
        const errorText = [result.result, result.error].filter(Boolean).join(' ');
        if (!authErrorNotified && isAuthError(errorText)) {
          authErrorNotified = true;
          this.deps.logger.error(
            { group: group.name, error: errorText.slice(0, 300) },
            'Auth error detected in container output',
          );
          await this.deps.routeOutbound(
            this.channels,
            chatJid,
            `${this.deps.assistantName}: [Auth Error] My API authentication has expired or is invalid. The admin needs to refresh the token. I'll retry automatically once it's fixed.`,
          ).catch(() => {});
        }
        return;
      }
      if (result.result) {
        // Clear acknowledgement reaction on first real output
        if (!firstOutputSent && lastTriggerMessageId && this.deps.react) {
          firstOutputSent = true;
          this.deps.react(chatJid, lastTriggerMessageId, '').catch(() => {});
        }
        const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        const text = this.deps.stripInternalTags(raw);
        this.deps.logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
        if (text) {
          await this.deps.routeOutbound(this.channels, chatJid, text, undefined, lastTriggerMessageId);
          outputSentToUser = true;
        }
        resetIdleTimer();
      }
      if (result.status === 'success') {
        this.deps.queue.notifyIdle(chatJid);
      }
    });

    if (idleTimer) clearTimeout(idleTimer);

    if (output === 'error' || hadError) {
      if (lastTriggerMessageId && this.deps.react) {
        // 🤡 — Telegram only allows a fixed set of reaction emojis for bot
        // accounts (no ❌). 🤡 is on the allowlist and reads as "this didn't
        // go well". Any future channels with stricter allowlists should
        // override or feature-detect.
        this.deps.react(chatJid, lastTriggerMessageId, '\u{1F921}').catch(() => {});
      }
      if (outputSentToUser) {
        this.consecutiveErrors[chatJid] = 0;
        this.deps.logger.warn(
          { group: group.name, authError: authErrorNotified },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }

      const errorCount = (this.consecutiveErrors[chatJid] || 0) + 1;
      this.consecutiveErrors[chatJid] = errorCount;

      // Only send generic error if we haven't already sent an auth-specific message
      if (errorCount === 1 && !authErrorNotified) {
        await this.deps.routeOutbound(this.channels, chatJid, `${this.deps.assistantName}: [Error] Something went wrong processing your message. Will retry on next message.`).catch(() => {});
      }

      if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
        this.deps.logger.error(
          { group: group.name, errorCount, authError: authErrorNotified },
          'Max consecutive errors reached, advancing cursor past failing messages',
        );
        this.consecutiveErrors[chatJid] = 0;
        return false;
      }

      this.lastAgentTimestamp[chatJid] = previousCursor;
      this.saveState();
      this.deps.logger.warn(
        { group: group.name, errorCount, authError: authErrorNotified },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    this.consecutiveErrors[chatJid] = 0;
    return true;
  }

  private async runAgent(
    group: ResolvedAgentRouting,
    prompt: string,
    chatJid: string,
    senderUserId: string | undefined,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<'success' | 'error'> {
    const isMain = group.folder === this.deps.mainGroupFolder;
    const sessionId = this.sessions[group.folder];

    const tasks = this.deps.getAllTasks();
    this.deps.writeTasksSnapshot(group.folder, isMain, this.deps.mapTasksToSnapshot(tasks));

    const availableGroups = this.getAvailableGroups();
    this.deps.writeGroupsSnapshot(
      group.folder,
      isMain,
      availableGroups,
      new Set(Object.keys(this.synthesizeRouting())),
    );

    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          this.applyOutputState(output, group.folder);
          await onOutput(output);
        }
      : undefined;

    // Look up the AgentGroup row for the container runner. The orchestrator
    // works in a private ResolvedAgentRouting shape; the container runner
    // takes AgentGroup directly (Phase 4A/A4).
    const agentGroup = getAgentGroupByFolder(group.folder);
    if (!agentGroup) {
      this.deps.logger.error(
        { folder: group.folder },
        'No agent_groups row for resolved group; aborting run',
      );
      return 'error';
    }

    try {
      const output = await this.deps.runContainerAgent(
        agentGroup,
        {
          prompt,
          sessionId,
          resumeAt: this.resumePositions[group.folder],
          groupFolder: group.folder,
          chatJid,
          isMain,
          // Phase 5E: thread the resolved sender user id so the runner can
          // gate admin-only MCP tools (e.g. create_agent) via
          // NANOCLAW_IS_ADMIN. Undefined for scheduled tasks (separate
          // call site in task-scheduler.ts) — they always get '0'.
          senderUserId,
        },
        (proc, containerName) => this.deps.queue.registerProcess(chatJid, proc, containerName, group.folder),
        wrappedOnOutput,
        group.channel,
      );

      this.applyOutputState(output, group.folder);

      if (output.status === 'error') {
        this.deps.logger.error(
          { group: group.name, error: output.error },
          'Container agent error',
        );
        delete this.resumePositions[group.folder];
        return 'error';
      }

      return 'success';
    } catch (err) {
      this.deps.logger.error({ group: group.name, err }, 'Agent error');
      delete this.resumePositions[group.folder];
      return 'error';
    }
  }

  private applyOutputState(output: ContainerOutput, groupFolder: string): void {
    if (output.newSessionId) {
      this.sessions[groupFolder] = output.newSessionId;
      this.deps.setSession(groupFolder, output.newSessionId);
    }
    if (output.resumeAt) {
      this.resumePositions[groupFolder] = output.resumeAt;
    }
  }

  async startMessageLoop(): Promise<void> {
    if (this.messageLoopRunning) {
      this.deps.logger.debug('Message loop already running, skipping duplicate start');
      return;
    }
    this.messageLoopRunning = true;

    this.deps.logger.info(`NanoClaw running (trigger: @${this.deps.assistantName})`);

    while (!this.stopRequested) {
      try {
        const allRegistered = this.synthesizeRouting();
        const jids = Object.keys(allRegistered);
        const { messages: rawMessages, newTimestamp } = this.deps.getNewMessages(
          jids,
          this.lastTimestamp,
          this.deps.assistantName,
        );

        const messages = rawMessages.filter((m) => !this.processedIds.has(m.id));

        if (messages.length > 0) {
          this.deps.logger.info({ count: messages.length }, 'New messages');

          if (newTimestamp > this.processedIdsTimestamp) {
            this.processedIds.clear();
            this.processedIdsTimestamp = newTimestamp;
          }
          for (const m of rawMessages) {
            this.processedIds.add(m.id);
          }

          // Defensive cap: prevent unbounded Set growth from clock skew or stuck cursors
          if (this.processedIds.size > 10_000) {
            this.processedIds.clear();
          }

          this.lastTimestamp = newTimestamp;
          this.saveState();

          const messagesByGroup = new Map<string, NewMessage[]>();
          for (const msg of messages) {
            const existing = messagesByGroup.get(msg.chat_jid);
            if (existing) {
              existing.push(msg);
            } else {
              messagesByGroup.set(msg.chat_jid, [msg]);
            }
          }

          for (const [chatJid, groupMessages] of messagesByGroup) {
            const group = allRegistered[chatJid];
            if (!group) {
              // Record inbound messages from JIDs with no registered group so
              // the unregistered_senders table fills with real diagnostic data.
              // Skip messages sent by the bot itself (is_from_me).
              const externalMessages = groupMessages.filter((m) => !m.is_from_me);
              if (externalMessages.length > 0) {
                const channel = this.channels.find((ch) => ch.ownsJid(chatJid));
                const channelName = channel?.name ?? 'unknown';
                // Use the most-recent message's sender_name; fall back to chatJid.
                const lastMsg = externalMessages[externalMessages.length - 1];
                this.deps.recordUnregisteredSender(
                  channelName,
                  chatJid,
                  lastMsg.sender_name || chatJid,
                );

                // Phase 4D D3: surface unknown-CHANNEL inbound messages to
                // an admin via a pending-channel approval card instead of
                // dropping silently. requestChannelApproval is idempotent
                // (PK on messaging_group_id) and short-circuits when the
                // chat has been sticky-denied or no agent group / DM is
                // reachable — the call is fire-and-forget.
                const senderInfo: SenderInfo = {
                  channel: channelName,
                  platform_id: chatJid,
                  sender_handle: lastMsg.sender,
                  sender_name: lastMsg.sender_name,
                };
                const senderUserId = resolveSender(senderInfo);
                void requestChannelApproval({
                  channel_type: channelName,
                  platform_id: chatJid,
                  chat_name: lastMsg.sender_name ?? undefined,
                  sender_user_id: senderUserId,
                  message_text: lastMsg.content,
                }).catch((err) =>
                  this.deps.logger.warn({ err }, 'requestChannelApproval failed'),
                );
              }
              continue;
            }

            // Phase 4B permissions enforcement. See processGroupMessages
            // above for the gate semantics: sender_scope='all' admits
            // everyone (admin gating happens in command-gate); sender_scope=
            // 'known' restricts to owner/admin/member via canAccessAgentGroup.
            const channel = this.channels.find((ch) => ch.ownsJid(chatJid));
            const lastMsg = groupMessages[groupMessages.length - 1];
            const senderInfo: SenderInfo = {
              channel: channel?.name ?? group.channel ?? 'unknown',
              platform_id: chatJid,
              sender_handle: lastMsg.sender,
              sender_name: lastMsg.sender_name,
            };
            const userId = resolveSender(senderInfo);
            const agentGroupRow = getAgentGroupByFolder(group.folder);
            if (agentGroupRow && group.sender_scope === 'known') {
              const access = canAccessAgentGroup(userId, agentGroupRow.id);
              if (!access.allowed) {
                this.deps.logger.debug(
                  { jid: chatJid, folder: group.folder, agentGroupId: agentGroupRow.id, userId, reason: access.reason },
                  'Dropped by sender_scope=known gate',
                );
                // Phase 4D D2: open a pending-sender approval card on
                // not-a-member denials. Same logic as processGroupMessages.
                if (access.reason === 'not-a-member') {
                  const mg = getMessagingGroup(senderInfo.channel, chatJid);
                  if (mg) {
                    void requestSenderApproval({
                      user_id: userId,
                      agent_group_id: agentGroupRow.id,
                      agent_group_folder: agentGroupRow.folder,
                      messaging_group_id: mg.id,
                      sender_identity: userId,
                      display_name: senderInfo.sender_name ?? undefined,
                      message_text: lastMsg.content,
                      originating_channel: senderInfo.channel,
                    }).catch((err) =>
                      this.deps.logger.warn({ err }, 'requestSenderApproval failed'),
                    );
                  }
                }
                continue;
              }
            }

            const isMainGroup = group.folder === this.deps.mainGroupFolder;
            // engage_mode='always' skips the trigger check entirely.
            // engage_mode='pattern' and 'mention-sticky' (Phase 4 forward-compat) require a trigger.
            const needsTrigger = !isMainGroup && group.engage_mode !== 'always';

            if (needsTrigger) {
              const pattern = this.deps.createTriggerPattern(group.pattern);
              const hasTrigger = groupMessages.some((m) =>
                pattern.test(m.content.trim()) &&
                (m.is_from_me || isTriggerAllowed(chatJid, m.sender, this.senderAllowlist)),
              );
              // Also trigger on replies to the bot's messages
              const hasReplyToBot = groupMessages.some((m) =>
                m.reply_context?.sender_name === this.deps.assistantName,
              );
              if (!hasTrigger && !hasReplyToBot) {
                // 'drop' and 'observe' produce identical runtime effects in v1: the channel
                // adapter stores every message before this orchestrator gate runs, so neither
                // policy can affect storage today. The distinction is reserved for Phase 4
                // where channel adapters consult policy before storing. For now both policies
                // skip agent invocation on non-trigger messages.
                continue;
              }
            }

            const allPending = this.deps.getMessagesSince(
              chatJid,
              this.lastAgentTimestamp[chatJid] || '',
              this.deps.assistantName,
            );
            const messagesToSend =
              allPending.length > 0 ? allPending : groupMessages;
            const formatted = this.deps.formatMessages(messagesToSend);

            if (this.deps.queue.sendMessage(chatJid, formatted)) {
              this.deps.logger.debug(
                { chatJid, count: messagesToSend.length },
                'Piped messages to active container',
              );
              this.lastAgentTimestamp[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              this.saveState();
            } else {
              this.deps.queue.enqueueMessageCheck(chatJid);
            }
          }
        }
      } catch (err) {
        this.deps.logger.error({ err }, 'Error in message loop');
      }

      // Wait for either the poll interval or a new-message event, whichever comes first
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.deps.dbEvents.removeListener('new-message', onEvent);
          resolve();
        }, this.deps.pollInterval);

        const onEvent = () => {
          clearTimeout(timer);
          this.deps.dbEvents.removeListener('new-message', onEvent);
          resolve();
        };

        this.deps.dbEvents.once('new-message', onEvent);
      });
    }

    this.messageLoopRunning = false;
  }

  recoverPendingMessages(): void {
    for (const [chatJid, group] of Object.entries(this.synthesizeRouting())) {
      const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';
      const pending = this.deps.getMessagesSince(chatJid, sinceTimestamp, this.deps.assistantName);
      if (pending.length > 0) {
        this.deps.logger.info(
          { group: group.name, pendingCount: pending.length },
          'Recovery: found unprocessed messages',
        );
        this.deps.queue.enqueueMessageCheck(chatJid);
      }
    }
  }
}
