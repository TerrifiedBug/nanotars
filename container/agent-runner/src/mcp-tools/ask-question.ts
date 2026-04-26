/**
 * Phase 4D D4 — `ask_question` MCP tool (container side).
 *
 * The agent calls this tool to surface a multiple-choice question (or
 * free-form prompt) to the user / approver. Container writes an IPC
 * payload to `/workspace/ipc/<group>/tasks/`; host's `processTaskIpc`
 * picks it up and persists a `pending_questions` row.
 *
 * Scope cut for D4: this is a fire-and-forget write. The actual outbound
 * card delivery + the answer-routing step (writing a `question_response`
 * system message back to the agent's inbox) are deferred to D6.
 *
 * Until D6 wires the inbox-poll loop, the tool returns immediately with
 * `{ question_id, status: 'pending' }` so the agent gets a usable handle
 * but knows the answer is not yet available. D6 will replace this with a
 * blocking poll (mirroring v2's `interactive.ts:askUserQuestion`).
 *
 * Module is split out from `ipc-mcp-stdio.ts` so it can be unit-tested
 * without booting the full MCP stdio transport. `ipc-mcp-stdio.ts` imports
 * `askQuestionInputSchema` + `buildAskQuestionPayload` and wraps them in
 * the standard `server.tool(...)` registration.
 */
import { z } from 'zod';

/** A normalised option as it lands in the host-side pending_questions row. */
export interface NormalizedOption {
  label: string;
  selectedLabel: string;
  value: string;
}

/**
 * Zod schema for the `ask_question` MCP input.
 *
 * Each option may be a plain string (used as both label and value) or a
 * `{label, selectedLabel?, value?}` object. Matches v2's interactive.ts
 * schema so the post-D6 card render can read the same shape.
 */
export const askQuestionOptionSchema = z.union([
  z.string(),
  z.object({
    label: z.string(),
    selectedLabel: z.string().optional(),
    value: z.string().optional(),
  }),
]);

export const askQuestionInputSchema = {
  question: z.string().min(1).describe('The question text shown to the user'),
  title: z.string().optional().describe('Optional short card title shown above the question'),
  options: z
    .array(askQuestionOptionSchema)
    .optional()
    .describe(
      'Multiple-choice options. Each may be a plain string (used as both label and value) or a {label, selectedLabel?, value?} object. Omit for a free-form-answer question.',
    ),
  expires_in_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional expiry timeout in seconds. Defaults to no explicit expiry.'),
};

/** Compose the input shape from the per-field schema (for type inference + tests). */
export const askQuestionInput = z.object(askQuestionInputSchema);

export type AskQuestionInput = z.infer<typeof askQuestionInput>;

export interface AskQuestionPayload {
  type: 'ask_question';
  questionId: string;
  title: string;
  question: string;
  options: NormalizedOption[];
  expires_in_seconds: number | null;
  groupFolder: string;
  timestamp: string;
}

/**
 * Normalise an arbitrary options array into the shape the host stores.
 * Mirrors v2 `container/agent-runner/src/mcp-tools/interactive.ts`'s
 * inline normalisation.
 */
export function normaliseAskQuestionOptions(
  raw: AskQuestionInput['options'] | undefined,
): NormalizedOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
    return {
      label: o.label,
      selectedLabel: o.selectedLabel ?? o.label,
      value: o.value ?? o.label,
    };
  });
}

/**
 * Generate a question id. Format `q-<ms>-<random>` matches v2's
 * `generateId` so log-line greppers work cross-tier.
 */
export function generateQuestionId(): string {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build the IPC payload that gets written to TASKS_DIR. Pure function so
 * tests can pin the timestamp / id.
 */
export function buildAskQuestionPayload(
  input: AskQuestionInput,
  ctx: { groupFolder: string; questionId?: string; now?: Date },
): AskQuestionPayload {
  const questionId = ctx.questionId ?? generateQuestionId();
  const now = ctx.now ?? new Date();
  return {
    type: 'ask_question',
    questionId,
    title: input.title ?? '',
    question: input.question,
    options: normaliseAskQuestionOptions(input.options),
    expires_in_seconds: input.expires_in_seconds ?? null,
    groupFolder: ctx.groupFolder,
    timestamp: now.toISOString(),
  };
}
