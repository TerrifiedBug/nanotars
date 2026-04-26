/**
 * Phase 5E — `create_agent` MCP tool (container side).
 *
 * Admin-only tool: spawn a new long-lived peer agent group. The container
 * writes a `create_agent` IPC payload to `/workspace/ipc/<group>/tasks/`;
 * the host's `processTaskIpc` dispatches to
 * `permissions/create-agent.ts:handleCreateAgent`, which re-validates the
 * sender's admin role, creates an `agent_groups` row, and scaffolds
 * `groups/<folder>/`.
 *
 * Registration is gated on `NANOCLAW_IS_ADMIN=1` in `ipc-mcp-stdio.ts` —
 * non-admin agent containers never see this tool. Defense in depth: even
 * if a non-admin somehow emitted the IPC payload, the host re-validates
 * the calling user's role before mutating state.
 *
 * Fire-and-forget shape: the tool returns immediately; result delivery is
 * a `notifyAgent` log-warn stub today (see `permissions/approval-primitive.ts`),
 * matching the pattern used by `emergency_stop` / `resume_processing`. Real
 * back-channel notification lands when notifyAgent gets wired.
 *
 * Wiring (messaging_group → agent_group) is NOT performed by this tool —
 * the operator runs `/wire` afterwards to attach the new agent to a chat.
 *
 * Module is split out from `ipc-mcp-stdio.ts` so it can be unit-tested
 * without booting the full MCP stdio transport, mirroring the
 * `lifecycle.ts` shape from Phase 5D.
 */
import { z } from 'zod';

export const createAgentInputSchema = {
  name: z
    .string()
    .min(1)
    .max(64)
    .describe('Display name for the new agent group (1-64 chars)'),
  instructions: z
    .string()
    .optional()
    .describe('Optional CLAUDE.md content for the new agent (its system prompt)'),
  folder: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/,
      'folder must be lowercase alphanumeric with hyphens/underscores',
    )
    .max(64)
    .optional()
    .describe('Optional folder name; auto-generated from `name` if omitted'),
};

export const createAgentInput = z.object(createAgentInputSchema);

export type CreateAgentInput = z.infer<typeof createAgentInput>;

export interface CreateAgentPayload {
  type: 'create_agent';
  name: string;
  instructions: string | null;
  folder: string | null;
  groupFolder: string;
  isMain: boolean;
  timestamp: string;
}

/**
 * Build the IPC payload for a `create_agent` request. Pure function so
 * tests can pin the timestamp.
 */
export function buildCreateAgentPayload(
  input: CreateAgentInput,
  ctx: { groupFolder: string; isMain: boolean; now?: Date },
): CreateAgentPayload {
  const now = ctx.now ?? new Date();
  return {
    type: 'create_agent',
    name: input.name,
    instructions: input.instructions ?? null,
    folder: input.folder ?? null,
    groupFolder: ctx.groupFolder,
    isMain: ctx.isMain,
    timestamp: now.toISOString(),
  };
}
