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
  MessagingGroup,
  MessagingGroupAgent,
  NewMessage,
  RegisteredGroup,
} from './types.js';
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
  getAllSynthesizedGroupRows,
  getMessagingGroup,
  getWiring,
  resolveAgentsForInbound,
} from './db/agent-groups.js';
import {
  canAccessAgentGroup,
  resolveSender,
  type SenderInfo,
} from './permissions.js';

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
  }

  /**
   * Legacy-compat shim: synthesize Record<jid, RegisteredGroup> from the
   * new entity-model tables. Plugins, IPC handlers, and the scheduler still
   * consume this shape; it's recomputed on every access (no cache).
   *
   * Multi-agent-per-chat (multiple wirings on the same messaging_group)
   * collapses to the first wiring with a warning. v1 doesn't enable
   * multi-agent today; this is forward-compat for Phase 4D.
   */
  get registeredGroups(): Record<string, RegisteredGroup> {
    return this.synthesizeRegisteredGroups();
  }

  private synthesizeRegisteredGroups(): Record<string, RegisteredGroup> {
    const rows = getAllSynthesizedGroupRows();
    const result: Record<string, RegisteredGroup> = {};
    for (const row of rows) {
      if (result[row.platform_id]) {
        // Already keyed (from a higher-priority wiring per ORDER BY); skip with warn.
        this.deps.logger.warn(
          {
            jid: row.platform_id,
            folder: row.agent_group_folder,
            existingFolder: result[row.platform_id].folder,
          },
          'Multiple wirings on same chat; legacy registeredGroups shim picking first by priority',
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
        // The legacy RegisteredGroup.added_at semantically maps to "when this
        // chat was registered for this agent" — i.e. the wiring's birth, not
        // the agent group's creation (which may have happened earlier when the
        // group was first created for a different chat).
        added_at: row.wiring_created_at,
        channel: row.channel_type,
        containerConfig,
        engage_mode: row.wiring_engage_mode as RegisteredGroup['engage_mode'],
        sender_scope: row.wiring_sender_scope as RegisteredGroup['sender_scope'],
        ignored_message_policy:
          row.wiring_ignored_message_policy as RegisteredGroup['ignored_message_policy'],
      };
    }
    return result;
  }

  /**
   * Resolve an inbound chat JID to its registered group, scoped to the
   * channel that owns the JID. Returns undefined when no wiring exists.
   * If multiple wirings exist (Phase 4D multi-agent), the first is returned
   * with a warning — legacy single-agent semantics.
   */
  private resolveGroupForChat(chatJid: string): RegisteredGroup | undefined {
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
    const groupCount = Object.keys(this.synthesizeRegisteredGroups()).length;
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
   * `setRegisteredGroup` call. Idempotent on (channel, platformId), (folder),
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

  registerGroup(jid: string, group: RegisteredGroup): void {
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
    const registeredJids = new Set(Object.keys(this.synthesizeRegisteredGroups()));

    return chats
      .filter((c) => c.jid !== '__group_sync__' && this.channels.some(ch => ch.ownsJid(c.jid)))
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
      }));
  }

  getRegisteredGroups(): Record<string, RegisteredGroup> {
    return this.synthesizeRegisteredGroups();
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

    // Phase 4A permissions hook (stubs return undefined / true so behavior is
    // unchanged; Phase 4B replaces with real users / user_roles checks). The
    // callsite is anchored here, just before any dispatch, so 4B can short-
    // circuit message processing for unauthorized senders without churning
    // the routing shape.
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
    if (agentGroupRow && !canAccessAgentGroup(userId, agentGroupRow.id)) {
      this.deps.logger.debug(
        { jid: chatJid, folder: group.folder, userId },
        'Access denied by permissions hook',
      );
      return true;
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

    const output = await this.runAgent(group, prompt, chatJid, async (result) => {
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
        this.deps.react(chatJid, lastTriggerMessageId, '\u{274C}').catch(() => {});
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
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
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
      new Set(Object.keys(this.synthesizeRegisteredGroups())),
    );

    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          this.applyOutputState(output, group.folder);
          await onOutput(output);
        }
      : undefined;

    // Look up the AgentGroup row for the container runner. The orchestrator
    // works in synthesized RegisteredGroup shape for legacy reasons; the
    // container runner has been moved to AgentGroup directly (Phase 4A/A4).
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
        const allRegistered = this.synthesizeRegisteredGroups();
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
              }
              continue;
            }

            // Phase 4A permissions hook (stubs return undefined / true so
            // behavior is unchanged; Phase 4B replaces with real users /
            // user_roles checks). Anchored here, before trigger evaluation,
            // so 4B can short-circuit dispatch for unauthorized senders.
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
            if (agentGroupRow && !canAccessAgentGroup(userId, agentGroupRow.id)) {
              this.deps.logger.debug(
                { jid: chatJid, folder: group.folder, userId },
                'Access denied by permissions hook',
              );
              continue;
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
    for (const [chatJid, group] of Object.entries(this.synthesizeRegisteredGroups())) {
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
