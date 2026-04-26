/**
 * Phase 4D D4 — pending_questions DB accessors.
 *
 * The `pending_questions` table (migration 018, schema in `src/db/init.ts`
 * PENDING_QUESTIONS_DDL) tracks open `ask_user_question` cards. Each row
 * binds a question card delivered to a chat to:
 *
 *   - the originating session (`session_id` — group_folder in v1-archive),
 *   - the outbound message that carried the card (`message_out_id`),
 *   - the platform routing (`platform_id`/`channel_type`/`thread_id`),
 *   - the rendered title + JSON-serialised options array,
 *   - an optional paired `pending_approvals` row so 4C's central
 *     card-expiry sweep can clean it up.
 *
 * D4 ships persistence + retrieval; the actual outbound card delivery and
 * the answer-routing step (writing a `question_response` system message
 * back to the agent's inbox) are deferred to D6. Until D6, the host-side
 * IPC handler logs the receipt of an `ask_question` payload, persists the
 * row, and stops there — the agent will see the tool call complete but
 * will not receive a response.
 *
 * INSERT OR IGNORE semantics: a retry with the same `question_id` is a
 * no-op and returns `false`, mirroring 4D's other dedup primitives
 * (pending_sender_approvals, pending_channel_approvals).
 */
import { getDb } from '../db/init.js';

export interface NormalizedOption {
  label: string;
  selectedLabel: string;
  value: string;
}

export interface PendingQuestion {
  question_id: string;
  session_id: string;
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  title: string;
  options: NormalizedOption[];
  approval_id: string | null;
  created_at: string;
}

/** Internal row shape — `options` is stored as JSON text. */
interface PendingQuestionRow {
  question_id: string;
  session_id: string;
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  title: string;
  options_json: string;
  approval_id: string | null;
  created_at: string;
}

/**
 * Insert a pending question row.
 *
 * Returns `true` if a new row was written, `false` if the
 * `question_id` PRIMARY KEY already existed (silent retry-drop).
 */
export function createPendingQuestion(pq: PendingQuestion): boolean {
  const result = getDb()
    .prepare(`INSERT OR IGNORE INTO pending_questions (
      question_id, session_id, message_out_id, platform_id, channel_type,
      thread_id, title, options_json, approval_id, created_at
    ) VALUES (
      @question_id, @session_id, @message_out_id, @platform_id, @channel_type,
      @thread_id, @title, @options_json, @approval_id, @created_at
    )`)
    .run({
      question_id: pq.question_id,
      session_id: pq.session_id,
      message_out_id: pq.message_out_id,
      platform_id: pq.platform_id,
      channel_type: pq.channel_type,
      thread_id: pq.thread_id,
      title: pq.title,
      options_json: JSON.stringify(pq.options),
      approval_id: pq.approval_id,
      created_at: pq.created_at,
    });
  return result.changes > 0;
}

function rowToPendingQuestion(row: PendingQuestionRow): PendingQuestion {
  let options: NormalizedOption[];
  try {
    const parsed = JSON.parse(row.options_json);
    options = Array.isArray(parsed) ? parsed : [];
  } catch {
    options = [];
  }
  return {
    question_id: row.question_id,
    session_id: row.session_id,
    message_out_id: row.message_out_id,
    platform_id: row.platform_id,
    channel_type: row.channel_type,
    thread_id: row.thread_id,
    title: row.title,
    options,
    approval_id: row.approval_id,
    created_at: row.created_at,
  };
}

export function getPendingQuestion(questionId: string): PendingQuestion | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM pending_questions WHERE question_id = ?`)
    .get(questionId) as PendingQuestionRow | undefined;
  return row ? rowToPendingQuestion(row) : undefined;
}

export function deletePendingQuestion(questionId: string): void {
  getDb().prepare(`DELETE FROM pending_questions WHERE question_id = ?`).run(questionId);
}

export function listPendingQuestionsBySession(sessionId: string): PendingQuestion[] {
  const rows = getDb()
    .prepare(`SELECT * FROM pending_questions WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId) as PendingQuestionRow[];
  return rows.map(rowToPendingQuestion);
}

export function getPendingQuestionByApprovalId(approvalId: string): PendingQuestion | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM pending_questions WHERE approval_id = ?`)
    .get(approvalId) as PendingQuestionRow | undefined;
  return row ? rowToPendingQuestion(row) : undefined;
}
