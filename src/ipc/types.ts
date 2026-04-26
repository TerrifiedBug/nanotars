import { AvailableGroup } from '../container-runner.js';
import {
  ContainerConfig,
  EngageMode,
  IgnoredMessagePolicy,
  SenderScope,
} from '../types.js';

/**
 * Minimal shape supplied to the IPC layer for routing/auth checks. Phase 4A's
 * A7 cleanup retired the legacy `RegisteredGroup` interface; the IPC surface
 * never needed more than per-JID folder lookup, so the dep here is the
 * narrowest possible map (`jid → { folder }`) — no engage axes, no container
 * config, no agent provider. Internally backed by the orchestrator's
 * synthesizer (which queries the entity-model tables).
 */
export type JidFolderMap = Record<string, { folder: string } | undefined>;

/**
 * Payload accepted by `IpcDeps.registerGroup`. Mirrors the v1 IPC
 * `register_group` shape (camelCase `containerConfig` and the four engage
 * axes). The host-side handler routes this through
 * `orchestrator.addAgentForChat` which writes the entity-model rows.
 */
export interface RegisterGroupArgs {
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
 * Phase 5D — soft-pause IPC payloads.
 *
 * The container-side `emergency_stop` / `resume_processing` MCP tools write
 * these into `/workspace/ipc/<group>/tasks/`. The host's `processTaskIpc`
 * dispatches them to `lifecycle-handlers.ts`, which re-validates the
 * sender's admin role before flipping the process-level `pausedGate`.
 *
 * Note: these are layered ON TOP of v1's existing GroupQueue.emergencyStop
 * (kill-now) — they do not replace it. Soft-pause only suspends future
 * wakes; in-flight containers complete their current turn.
 */
export interface EmergencyStopTask {
  type: 'emergency_stop';
  reason?: string;
  groupFolder: string;
  isMain: boolean;
  timestamp: string;
}

export interface ResumeProcessingTask {
  type: 'resume_processing';
  reason?: string;
  groupFolder: string;
  isMain: boolean;
  timestamp: string;
}

/** Discriminated union for IPC message commands. */
export type IpcMessage =
  | { type: 'message'; chatJid: string; text: string; sender?: string; replyTo?: string }
  | { type: 'send_file'; chatJid: string; filePath: string; fileName?: string; caption?: string }
  | { type: 'react'; chatJid: string; messageId: string; emoji: string };

/** Type guard for IPC messages. */
export function isIpcMessage(data: unknown): data is IpcMessage {
  if (typeof data !== 'object' || data === null || !('type' in data)) return false;
  const d = data as Record<string, unknown>;
  switch (d.type) {
    case 'message':
      return typeof d.chatJid === 'string' && typeof d.text === 'string';
    case 'send_file':
      return typeof d.chatJid === 'string' && typeof d.filePath === 'string';
    case 'react':
      return typeof d.chatJid === 'string' && typeof d.messageId === 'string' && typeof d.emoji === 'string';
    default:
      return false;
  }
}

/** Valid task IPC command types. */
export const TASK_IPC_TYPES = new Set([
  'schedule_task', 'pause_task', 'resume_task', 'update_task', 'cancel_task',
  'refresh_groups', 'register_group', 'emergency_stop', 'resume_processing',
  // Phase 4D D4: agent-asks-user-a-question card. Container writes the
  // payload here; host persists a pending_questions row. Card delivery +
  // answer round-trip wiring is deferred to D6.
  'ask_question',
]);

/** Validate that raw IPC data has a known task type. */
export function isValidTaskIpc(data: unknown): data is { type: string } & Record<string, unknown> {
  if (typeof data !== 'object' || data === null || !('type' in data)) return false;
  const d = data as Record<string, unknown>;
  return typeof d.type === 'string' && TASK_IPC_TYPES.has(d.type);
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string, sender?: string, replyTo?: string) => Promise<void>;
  sendFile: (jid: string, buffer: Buffer, mime: string, fileName: string, caption?: string) => Promise<boolean>;
  react: (jid: string, messageId: string, emoji: string) => Promise<void>;
  /** Per-JID folder map used for IPC authorization decisions. */
  registeredGroups: () => JidFolderMap;
  /** Compound write: ensure messaging_group + agent_group + wiring rows exist. */
  registerGroup: (jid: string, group: RegisterGroupArgs) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  emergencyStop?: () => Promise<void>;
  resumeProcessing?: () => void;
}
