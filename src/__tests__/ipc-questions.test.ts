/**
 * Phase 4D D4 — host-side `ask_question` IPC handler integration tests.
 *
 * Drives `processTaskIpc` directly with an `ask_question` payload and
 * asserts the host persists a `pending_questions` row + handles the
 * dedup / validation edge cases. Card delivery and answer round-trip
 * are out of scope here — that's D6.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, getDb } from '../db/init.js';
import { processTaskIpc } from '../ipc/tasks.js';
import type { IpcDeps } from '../ipc/types.js';
import {
  getPendingQuestion,
  listPendingQuestionsBySession,
} from '../permissions/pending-questions.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
});

function makeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: vi.fn(),
    sendFile: vi.fn(async () => true),
    react: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    syncGroupMetadata: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    ...overrides,
  };
}

describe('processTaskIpc: ask_question', () => {
  it('persists a pending_questions row when the payload is well-formed', async () => {
    await processTaskIpc(
      {
        type: 'ask_question',
        questionId: 'q-abc',
        title: 'Confirm deletion',
        question: 'Delete the selected files?',
        options: ['Yes', 'No'],
        platform_id: 'tg-chat-1',
        channel_type: 'telegram',
        thread_id: null,
      },
      'main', true, makeDeps(),
    );

    const row = getPendingQuestion('q-abc');
    expect(row).toBeDefined();
    expect(row!.session_id).toBe('main');
    expect(row!.title).toBe('Confirm deletion');
    expect(row!.platform_id).toBe('tg-chat-1');
    expect(row!.channel_type).toBe('telegram');
    expect(row!.options).toEqual([
      { label: 'Yes', selectedLabel: 'Yes', value: 'Yes' },
      { label: 'No', selectedLabel: 'No', value: 'No' },
    ]);
  });

  it('normalises object-shaped options preserving custom selectedLabel + value', async () => {
    await processTaskIpc(
      {
        type: 'ask_question',
        questionId: 'q-objs',
        title: 't',
        question: 'pick',
        options: [
          { label: 'Approve', selectedLabel: 'Approved', value: 'approve' },
          { label: 'Skip' }, // selectedLabel + value default to label
        ],
      },
      'main', true, makeDeps(),
    );

    const row = getPendingQuestion('q-objs');
    expect(row!.options).toEqual([
      { label: 'Approve', selectedLabel: 'Approved', value: 'approve' },
      { label: 'Skip', selectedLabel: 'Skip', value: 'Skip' },
    ]);
  });

  it('uses sourceGroup (verified IPC identity) as session_id', async () => {
    await processTaskIpc(
      {
        type: 'ask_question',
        questionId: 'q-from-child',
        title: 't',
        question: 'q',
        options: ['ok'],
      },
      'child-agent', false, makeDeps(), // non-main can ask too
    );

    const row = getPendingQuestion('q-from-child');
    expect(row).toBeDefined();
    expect(row!.session_id).toBe('child-agent');
  });

  it('non-main groups are allowed to ask questions in their own session', async () => {
    await processTaskIpc(
      {
        type: 'ask_question',
        questionId: 'q-nm',
        title: 't',
        question: 'q',
        options: ['a'],
      },
      'sub', false, makeDeps(),
    );

    expect(listPendingQuestionsBySession('sub')).toHaveLength(1);
  });

  it('drops second ask with the same questionId (PK dedup)', async () => {
    const payload = {
      type: 'ask_question' as const,
      questionId: 'q-dup',
      title: 'first',
      question: 'q',
      options: ['a'],
    };
    await processTaskIpc(payload, 'main', true, makeDeps());
    await processTaskIpc({ ...payload, title: 'second' }, 'main', true, makeDeps());

    const rows = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM pending_questions WHERE question_id = ?`)
      .get('q-dup') as { n: number };
    expect(rows.n).toBe(1);

    // Original title preserved (second insert was ignored).
    const row = getPendingQuestion('q-dup');
    expect(row!.title).toBe('first');
  });

  it('rejects payload missing questionId — no row inserted', async () => {
    await processTaskIpc(
      {
        type: 'ask_question',
        // questionId omitted
        title: 't',
        question: 'q',
        options: ['a'],
      },
      'main', true, makeDeps(),
    );

    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM pending_questions`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('rejects payload missing question text — no row inserted', async () => {
    await processTaskIpc(
      {
        type: 'ask_question',
        questionId: 'q-no-text',
        title: 't',
        // question omitted
        options: ['a'],
      },
      'main', true, makeDeps(),
    );

    expect(getPendingQuestion('q-no-text')).toBeUndefined();
  });

  it('handles non-array options gracefully (stores empty options array)', async () => {
    await processTaskIpc(
      {
        type: 'ask_question',
        questionId: 'q-bad-opts',
        title: 't',
        question: 'q',
        options: 'not-an-array' as unknown,
      },
      'main', true, makeDeps(),
    );

    const row = getPendingQuestion('q-bad-opts');
    expect(row).toBeDefined();
    expect(row!.options).toEqual([]);
  });

  it('skips object options that lack a string label', async () => {
    await processTaskIpc(
      {
        type: 'ask_question',
        questionId: 'q-mixed',
        title: 't',
        question: 'q',
        options: [
          'first',
          { value: 'no-label' }, // missing label — should be skipped
          { label: 'second' },
        ],
      },
      'main', true, makeDeps(),
    );

    const row = getPendingQuestion('q-mixed');
    expect(row!.options.map((o) => o.label)).toEqual(['first', 'second']);
  });

  it('defaults missing message_out_id to questionId', async () => {
    await processTaskIpc(
      {
        type: 'ask_question',
        questionId: 'q-mo',
        title: 't',
        question: 'q',
        options: ['a'],
        // message_out_id omitted
      },
      'main', true, makeDeps(),
    );

    const row = getPendingQuestion('q-mo');
    expect(row!.message_out_id).toBe('q-mo');
  });

  it('uses provided message_out_id when present', async () => {
    await processTaskIpc(
      {
        type: 'ask_question',
        questionId: 'q-mo2',
        message_out_id: 'msg-out-explicit',
        title: 't',
        question: 'q',
        options: ['a'],
      },
      'main', true, makeDeps(),
    );

    const row = getPendingQuestion('q-mo2');
    expect(row!.message_out_id).toBe('msg-out-explicit');
  });

  // Phase 4D D6: card delivery wiring
  it('D6: delivers the question via deps.sendMessage when platform_id is supplied', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const deps = makeDeps({ sendMessage });

    await processTaskIpc(
      {
        type: 'ask_question',
        questionId: 'q-deliver',
        title: 'Confirm deletion',
        question: 'Delete the selected files?',
        options: ['Yes', 'No'],
        platform_id: 'tg-chat-1',
        channel_type: 'telegram',
      },
      'main', true, deps,
    );

    // Wait for the fire-and-forget delivery to settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [jid, text] = sendMessage.mock.calls[0];
    expect(jid).toBe('tg-chat-1');
    expect(text).toContain('Confirm deletion');
    expect(text).toContain('Delete the selected files?');
    expect(text).toContain('Reply "Yes" to Yes');
    expect(text).toContain('Reply "No" to No');
    expect(text).toContain('q-deliver');
  });

  it('D6: skips delivery when no platform_id is provided', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const deps = makeDeps({ sendMessage });

    await processTaskIpc(
      {
        type: 'ask_question',
        questionId: 'q-no-platform',
        title: 't',
        question: 'q',
        options: ['ok'],
        // platform_id intentionally omitted
      },
      'main', true, deps,
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(sendMessage).not.toHaveBeenCalled();
    // Row was still persisted.
    expect(getPendingQuestion('q-no-platform')).toBeDefined();
  });

  it('D6: duplicate questionId does not double-send the card', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const deps = makeDeps({ sendMessage });

    const payload = {
      type: 'ask_question' as const,
      questionId: 'q-dup-deliver',
      title: 't',
      question: 'q',
      options: ['ok'],
      platform_id: 'tg-1',
    };
    await processTaskIpc(payload, 'main', true, deps);
    await processTaskIpc(payload, 'main', true, deps);
    await new Promise((r) => setTimeout(r, 10));

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
