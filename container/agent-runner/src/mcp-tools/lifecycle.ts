/**
 * Phase 5D — `emergency_stop` / `resume_processing` MCP tools (container side).
 *
 * The agent calls these tools to ask the host to soft-pause or resume
 * processing of inbound messages and tasks. Container writes an IPC payload
 * to `/workspace/ipc/<group>/tasks/`; host's `processTaskIpc` picks it up
 * and dispatches to a handler that re-validates the calling user's admin
 * privilege before flipping the process-level `pausedGate` flag.
 *
 * Two layers, two concerns (see spec §5D):
 *   - emergency_stop (this tool) → host pausedGate.pause: queue future wakes
 *     while in-flight containers complete their current turn.
 *   - The existing v1 GroupQueue.emergencyStop() (kill-now) is preserved as
 *     a separate path; this tool does NOT call it directly. The host
 *     handler may opt to kill if desired (TODO marker in handler).
 *
 * Module is split out from `ipc-mcp-stdio.ts` so it can be unit-tested
 * without booting the full MCP stdio transport, mirroring the
 * `ask-question.ts` shape from Phase 4D D4.
 */
import { z } from 'zod';

export const emergencyStopInputSchema = {
  reason: z
    .string()
    .optional()
    .describe('Free-form reason for the pause (e.g. "user asked me to stop"). Surfaced in host logs.'),
};

export const resumeProcessingInputSchema = {
  reason: z
    .string()
    .optional()
    .describe('Free-form reason for the resume. Surfaced in host logs.'),
};

export const emergencyStopInput = z.object(emergencyStopInputSchema);
export const resumeProcessingInput = z.object(resumeProcessingInputSchema);

export type EmergencyStopInput = z.infer<typeof emergencyStopInput>;
export type ResumeProcessingInput = z.infer<typeof resumeProcessingInput>;

export interface EmergencyStopPayload {
  type: 'emergency_stop';
  reason?: string;
  groupFolder: string;
  isMain: boolean;
  timestamp: string;
}

export interface ResumeProcessingPayload {
  type: 'resume_processing';
  reason?: string;
  groupFolder: string;
  isMain: boolean;
  timestamp: string;
}

/**
 * Build the IPC payload for an `emergency_stop` (soft-pause) request.
 * Pure function so tests can pin the timestamp.
 */
export function buildEmergencyStopPayload(
  input: EmergencyStopInput,
  ctx: { groupFolder: string; isMain: boolean; now?: Date },
): EmergencyStopPayload {
  const now = ctx.now ?? new Date();
  const payload: EmergencyStopPayload = {
    type: 'emergency_stop',
    groupFolder: ctx.groupFolder,
    isMain: ctx.isMain,
    timestamp: now.toISOString(),
  };
  if (input.reason !== undefined) payload.reason = input.reason;
  return payload;
}

/**
 * Build the IPC payload for a `resume_processing` request.
 * Pure function so tests can pin the timestamp.
 */
export function buildResumeProcessingPayload(
  input: ResumeProcessingInput,
  ctx: { groupFolder: string; isMain: boolean; now?: Date },
): ResumeProcessingPayload {
  const now = ctx.now ?? new Date();
  const payload: ResumeProcessingPayload = {
    type: 'resume_processing',
    groupFolder: ctx.groupFolder,
    isMain: ctx.isMain,
    timestamp: now.toISOString(),
  };
  if (input.reason !== undefined) payload.reason = input.reason;
  return payload;
}
