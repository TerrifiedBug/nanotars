/**
 * MessageOrchestrator — owns the message-loop state and processing logic.
 * Extracted from index.ts for testability.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import type { Channel, NewMessage, RegisteredGroup } from './types.js';
import type { ContainerOutput } from './container-runner.js';
import type { AvailableGroup } from './snapshots.js';
import type { GroupQueue } from './group-queue.js';
import type { ScheduledTask } from './types.js';

/** Dependency injection interface for the orchestrator. */
export interface OrchestratorDeps {
  // DB functions
  getRouterState: (key: string) => string | undefined;
  setRouterState: (key: string, value: string) => void;
  getAllSessions: () => Record<string, string>;
  setSession: (groupFolder: string, sessionId: string) => void;
  getAllRegisteredGroups: () => Record<string, RegisteredGroup>;
  setRegisteredGroup: (jid: string, group: RegisteredGroup, channel?: string) => void;
  getMessagesSince: (chatJid: string, since: string, botPrefix: string) => NewMessage[];
  getNewMessages: (jids: string[], lastTs: string, botPrefix: string) => { messages: NewMessage[]; newTimestamp: string };
  getAllChats: () => Array<{ jid: string; name: string; last_message_time: string }>;
  getAllTasks: () => ScheduledTask[];

  // Routing
  formatMessages: (messages: NewMessage[]) => string;
  routeOutbound: (channels: Channel[], jid: string, text: string, sender?: string) => Promise<boolean>;
  stripInternalTags: (text: string) => string;
  createTriggerPattern: (trigger: string) => RegExp;

  // Container runner
  runContainerAgent: (
    group: RegisteredGroup,
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
  registeredGroups: Record<string, RegisteredGroup> = {};
  private lastAgentTimestamp: Record<string, string> = {};
  private consecutiveErrors: Record<string, number> = {};
  private processedIds = new Set<string>();
  private processedIdsTimestamp = '';
  channels: Channel[] = [];
  private messageLoopRunning = false;
  private stopRequested = false;

  constructor(private deps: OrchestratorDeps) {}

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
    this.registeredGroups = this.deps.getAllRegisteredGroups();
    this.deps.logger.info(
      { groupCount: Object.keys(this.registeredGroups).length },
      'State loaded',
    );
  }

  private saveState(): void {
    this.deps.setRouterState('last_timestamp', this.lastTimestamp);
    this.deps.setRouterState(
      'last_agent_timestamp',
      JSON.stringify(this.lastAgentTimestamp),
    );
  }

  registerGroup(jid: string, group: RegisteredGroup): void {
    this.registeredGroups[jid] = group;
    this.deps.setRegisteredGroup(jid, group);

    const groupDir = path.join(this.deps.groupsDir, group.folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    this.deps.logger.info(
      { jid, name: group.name, folder: group.folder },
      'Group registered',
    );
  }

  getAvailableGroups(): AvailableGroup[] {
    const chats = this.deps.getAllChats();
    const registeredJids = new Set(Object.keys(this.registeredGroups));

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
    return this.registeredGroups;
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

  async processGroupMessages(chatJid: string): Promise<boolean> {
    const group = this.registeredGroups[chatJid];
    if (!group) return true;

    const isMainGroup = group.folder === this.deps.mainGroupFolder;

    const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';
    const missedMessages = this.deps.getMessagesSince(chatJid, sinceTimestamp, this.deps.assistantName);

    if (missedMessages.length === 0) return true;

    // For non-main groups, check if trigger is required and present
    if (!isMainGroup && group.requiresTrigger !== false) {
      const pattern = this.deps.createTriggerPattern(group.trigger);
      const hasTrigger = missedMessages.some((m) =>
        pattern.test(m.content.trim()),
      );
      if (!hasTrigger) return true;
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

    let hadError = false;
    let outputSentToUser = false;

    const output = await this.runAgent(group, prompt, chatJid, async (result) => {
      if (result.status === 'error') {
        hadError = true;
        return;
      }
      if (result.result) {
        const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        const text = this.deps.stripInternalTags(raw);
        this.deps.logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
        if (text) {
          await this.deps.routeOutbound(this.channels, chatJid, text);
          outputSentToUser = true;
        }
        resetIdleTimer();
      }
    });

    if (idleTimer) clearTimeout(idleTimer);

    if (output === 'error' || hadError) {
      if (outputSentToUser) {
        this.consecutiveErrors[chatJid] = 0;
        this.deps.logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
        return true;
      }

      const errorCount = (this.consecutiveErrors[chatJid] || 0) + 1;
      this.consecutiveErrors[chatJid] = errorCount;

      if (errorCount === 1) {
        await this.deps.routeOutbound(this.channels, chatJid, `${this.deps.assistantName}: [Error] Something went wrong processing your message. Will retry on next message.`).catch(() => {});
      }

      if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
        this.deps.logger.error(
          { group: group.name, errorCount },
          'Max consecutive errors reached, advancing cursor past failing messages',
        );
        this.consecutiveErrors[chatJid] = 0;
        return false;
      }

      this.lastAgentTimestamp[chatJid] = previousCursor;
      this.saveState();
      this.deps.logger.warn({ group: group.name, errorCount }, 'Agent error, rolled back message cursor for retry');
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
      new Set(Object.keys(this.registeredGroups)),
    );

    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          if (output.newSessionId) {
            this.sessions[group.folder] = output.newSessionId;
            this.deps.setSession(group.folder, output.newSessionId);
          }
          if (output.resumeAt) {
            this.resumePositions[group.folder] = output.resumeAt;
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const output = await this.deps.runContainerAgent(
        group,
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
      );

      if (output.newSessionId) {
        this.sessions[group.folder] = output.newSessionId;
        this.deps.setSession(group.folder, output.newSessionId);
      }
      if (output.resumeAt) {
        this.resumePositions[group.folder] = output.resumeAt;
      }

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

  async startMessageLoop(): Promise<void> {
    if (this.messageLoopRunning) {
      this.deps.logger.debug('Message loop already running, skipping duplicate start');
      return;
    }
    this.messageLoopRunning = true;

    this.deps.logger.info(`NanoClaw running (trigger: @${this.deps.assistantName})`);

    while (!this.stopRequested) {
      try {
        const jids = Object.keys(this.registeredGroups);
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
            const group = this.registeredGroups[chatJid];
            if (!group) continue;

            const isMainGroup = group.folder === this.deps.mainGroupFolder;
            const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

            if (needsTrigger) {
              const pattern = this.deps.createTriggerPattern(group.trigger);
              const hasTrigger = groupMessages.some((m) =>
                pattern.test(m.content.trim()),
              );
              if (!hasTrigger) continue;
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
  }

  recoverPendingMessages(): void {
    for (const [chatJid, group] of Object.entries(this.registeredGroups)) {
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
