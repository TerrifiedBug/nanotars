import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getDb } from '../../db/init.js';
import {
  createPendingQuestion,
  deletePendingQuestion,
  getPendingQuestion,
  getPendingQuestionByApprovalId,
  listPendingQuestionsBySession,
  type PendingQuestion,
} from '../pending-questions.js';

beforeEach(() => {
  _initTestDatabase();
});

function fixture(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    question_id: 'q-test-1',
    session_id: 'main',
    message_out_id: 'msg-out-1',
    platform_id: 'tg-chat-1',
    channel_type: 'telegram',
    thread_id: null,
    title: 'Confirm deletion',
    options: [
      { label: 'Yes', selectedLabel: 'Yes', value: 'yes' },
      { label: 'No', selectedLabel: 'No', value: 'no' },
    ],
    approval_id: null,
    created_at: new Date('2026-04-25T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

describe('createPendingQuestion', () => {
  it('inserts a new row and returns true', () => {
    const ok = createPendingQuestion(fixture());
    expect(ok).toBe(true);

    const row = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM pending_questions`)
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('persists options as JSON text', () => {
    createPendingQuestion(fixture());
    const row = getDb()
      .prepare(`SELECT options_json FROM pending_questions WHERE question_id = ?`)
      .get('q-test-1') as { options_json: string };
    const parsed = JSON.parse(row.options_json);
    expect(parsed).toEqual([
      { label: 'Yes', selectedLabel: 'Yes', value: 'yes' },
      { label: 'No', selectedLabel: 'No', value: 'no' },
    ]);
  });

  it('INSERT OR IGNORE: second insert with same question_id returns false', () => {
    expect(createPendingQuestion(fixture())).toBe(true);
    expect(createPendingQuestion(fixture({ title: 'different title' }))).toBe(false);

    const row = getDb()
      .prepare(`SELECT title FROM pending_questions WHERE question_id = ?`)
      .get('q-test-1') as { title: string };
    // The second insert was ignored — original title preserved.
    expect(row.title).toBe('Confirm deletion');
  });

  it('round-trips empty options array', () => {
    createPendingQuestion(fixture({ question_id: 'q-empty', options: [] }));
    const fetched = getPendingQuestion('q-empty');
    expect(fetched?.options).toEqual([]);
  });
});

describe('getPendingQuestion', () => {
  it('returns undefined when no row exists', () => {
    expect(getPendingQuestion('does-not-exist')).toBeUndefined();
  });

  it('parses options_json back into an array', () => {
    createPendingQuestion(fixture());
    const fetched = getPendingQuestion('q-test-1');
    expect(fetched).toBeDefined();
    expect(fetched!.options).toEqual([
      { label: 'Yes', selectedLabel: 'Yes', value: 'yes' },
      { label: 'No', selectedLabel: 'No', value: 'no' },
    ]);
    expect(fetched!.title).toBe('Confirm deletion');
    expect(fetched!.session_id).toBe('main');
  });

  it('returns empty options array when options_json is malformed', () => {
    createPendingQuestion(fixture());
    // Tamper with the row to simulate an old/corrupt JSON value.
    getDb()
      .prepare(`UPDATE pending_questions SET options_json = ? WHERE question_id = ?`)
      .run('not-json', 'q-test-1');
    const fetched = getPendingQuestion('q-test-1');
    expect(fetched?.options).toEqual([]);
  });
});

describe('deletePendingQuestion', () => {
  it('removes the row', () => {
    createPendingQuestion(fixture());
    deletePendingQuestion('q-test-1');
    expect(getPendingQuestion('q-test-1')).toBeUndefined();
  });

  it('is a no-op when the question does not exist', () => {
    expect(() => deletePendingQuestion('missing')).not.toThrow();
  });
});

describe('listPendingQuestionsBySession', () => {
  it('returns rows scoped to the given session, ordered by created_at', () => {
    createPendingQuestion(fixture({ question_id: 'q1', session_id: 'main', created_at: '2026-04-25T00:00:00.000Z' }));
    createPendingQuestion(fixture({ question_id: 'q2', session_id: 'main', created_at: '2026-04-25T01:00:00.000Z' }));
    createPendingQuestion(fixture({ question_id: 'q3', session_id: 'other-group', created_at: '2026-04-25T00:30:00.000Z' }));

    const rows = listPendingQuestionsBySession('main');
    expect(rows.map((r) => r.question_id)).toEqual(['q1', 'q2']);
  });

  it('returns empty array for an unknown session', () => {
    expect(listPendingQuestionsBySession('nobody')).toEqual([]);
  });
});

describe('getPendingQuestionByApprovalId', () => {
  function seedApproval(approvalId: string): void {
    getDb()
      .prepare(
        `INSERT INTO pending_approvals (
          approval_id, session_id, request_id, action, payload, created_at
        ) VALUES (?, NULL, ?, 'ask_question', '{}', ?)`,
      )
      .run(approvalId, `req-${approvalId}`, new Date().toISOString());
  }

  it('returns the row with a matching approval_id', () => {
    seedApproval('appr-1');
    createPendingQuestion(fixture({ question_id: 'q-with-approval', approval_id: 'appr-1' }));
    const fetched = getPendingQuestionByApprovalId('appr-1');
    expect(fetched).toBeDefined();
    expect(fetched!.question_id).toBe('q-with-approval');
  });

  it('returns undefined when no row matches', () => {
    createPendingQuestion(fixture({ question_id: 'q-no-approval', approval_id: null }));
    expect(getPendingQuestionByApprovalId('appr-missing')).toBeUndefined();
  });
});
