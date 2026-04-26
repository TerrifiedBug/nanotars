/**
 * Phase 4D D5: in-flight dedup integration tests for the three pending_* tables.
 *
 * Exercises the PRIMARY KEY / UNIQUE constraints that prevent duplicate
 * in-flight rows:
 *
 *   pending_sender_approvals  — UNIQUE(messaging_group_id, sender_identity)
 *   pending_channel_approvals — PRIMARY KEY (messaging_group_id)
 *   pending_questions         — PRIMARY KEY (question_id)
 *
 * Uses _initTestDatabase() so the real schema (createSchema) is in place —
 * same pattern as src/db/__tests__/agent-groups.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getDb } from '../db/init.js';
import { createAgentGroup, createMessagingGroup } from '../db/index.js';
import { ensureUser } from '../permissions/users.js';

// ---------------------------------------------------------------------------
// Helpers — seed the FK-required rows once per test via beforeEach.
// ---------------------------------------------------------------------------

function seedPrereqs() {
  const user = ensureUser({ id: 'whatsapp:approver', kind: 'whatsapp' });
  const ag = createAgentGroup({ name: 'main', folder: 'main' });
  const mg = createMessagingGroup({
    channel_type: 'whatsapp',
    platform_id: 'g@s.whatsapp.net',
  });
  return { user, ag, mg };
}

// ---------------------------------------------------------------------------
// pending_sender_approvals
// ---------------------------------------------------------------------------

describe('pending_sender_approvals dedup (UNIQUE messaging_group_id, sender_identity)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('INSERT OR IGNORE silently drops a duplicate (messaging_group_id, sender_identity)', () => {
    const { ag, mg } = seedPrereqs();
    const db = getDb();

    const insert = db.prepare(`
      INSERT OR IGNORE INTO pending_sender_approvals
        (id, messaging_group_id, agent_group_id, sender_identity, original_message,
         approver_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run('row-1', mg.id, ag.id, 'alice', 'first request', 'whatsapp:approver', new Date().toISOString());
    insert.run('row-2', mg.id, ag.id, 'alice', 'second request', 'whatsapp:approver', new Date().toISOString());

    const rows = db
      .prepare(`SELECT * FROM pending_sender_approvals WHERE messaging_group_id = ?`)
      .all(mg.id) as Array<{ id: string; original_message: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('row-1');
    expect(rows[0].original_message).toBe('first request');
  });

  it('plain INSERT throws UNIQUE violation for duplicate (messaging_group_id, sender_identity)', () => {
    const { ag, mg } = seedPrereqs();
    const db = getDb();

    const insert = db.prepare(`
      INSERT INTO pending_sender_approvals
        (id, messaging_group_id, agent_group_id, sender_identity, original_message,
         approver_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run('row-a', mg.id, ag.id, 'bob', 'first', 'whatsapp:approver', new Date().toISOString());
    expect(() =>
      insert.run('row-b', mg.id, ag.id, 'bob', 'second', 'whatsapp:approver', new Date().toISOString()),
    ).toThrow(/UNIQUE/);
  });

  it('different sender_identity values on the same messaging_group do not conflict', () => {
    const { ag, mg } = seedPrereqs();
    const db = getDb();

    const insert = db.prepare(`
      INSERT INTO pending_sender_approvals
        (id, messaging_group_id, agent_group_id, sender_identity, original_message,
         approver_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run('row-x', mg.id, ag.id, 'carol', 'msg-carol', 'whatsapp:approver', new Date().toISOString());
    insert.run('row-y', mg.id, ag.id, 'dave', 'msg-dave', 'whatsapp:approver', new Date().toISOString());

    const rows = db
      .prepare(`SELECT * FROM pending_sender_approvals WHERE messaging_group_id = ?`)
      .all(mg.id) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// pending_channel_approvals
// ---------------------------------------------------------------------------

describe('pending_channel_approvals dedup (PRIMARY KEY messaging_group_id)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('INSERT OR IGNORE silently drops a duplicate messaging_group_id', () => {
    const { ag, mg } = seedPrereqs();
    const db = getDb();

    const insert = db.prepare(`
      INSERT OR IGNORE INTO pending_channel_approvals
        (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    insert.run(mg.id, ag.id, 'first mention', 'whatsapp:approver', new Date().toISOString());
    insert.run(mg.id, ag.id, 'second mention', 'whatsapp:approver', new Date().toISOString());

    const rows = db
      .prepare(`SELECT * FROM pending_channel_approvals WHERE messaging_group_id = ?`)
      .all(mg.id) as Array<{ original_message: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].original_message).toBe('first mention');
  });

  it('plain INSERT throws on duplicate messaging_group_id (PK violation)', () => {
    const { ag, mg } = seedPrereqs();
    const db = getDb();

    const insert = db.prepare(`
      INSERT INTO pending_channel_approvals
        (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    insert.run(mg.id, ag.id, 'first', 'whatsapp:approver', new Date().toISOString());
    expect(() =>
      insert.run(mg.id, ag.id, 'second', 'whatsapp:approver', new Date().toISOString()),
    ).toThrow(/UNIQUE/);
  });
});

// ---------------------------------------------------------------------------
// pending_questions
// ---------------------------------------------------------------------------

describe('pending_questions uniqueness (PRIMARY KEY question_id)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('two distinct question_ids both insert without conflict', () => {
    const db = getDb();

    const insert = db.prepare(`
      INSERT INTO pending_questions
        (question_id, session_id, message_out_id, title, options_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insert.run('q-uuid-1', 'session-A', 'msg-1', 'Pick one', '[]', new Date().toISOString());
    insert.run('q-uuid-2', 'session-A', 'msg-2', 'Pick two', '[]', new Date().toISOString());

    const rows = db
      .prepare(`SELECT question_id FROM pending_questions WHERE session_id = ?`)
      .all('session-A') as Array<{ question_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.question_id).sort()).toEqual(['q-uuid-1', 'q-uuid-2']);
  });

  it('duplicate question_id is rejected (PK violation)', () => {
    const db = getDb();

    const insert = db.prepare(`
      INSERT INTO pending_questions
        (question_id, session_id, message_out_id, title, options_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insert.run('q-dup', 'session-B', 'msg-A', 'Q1', '[]', new Date().toISOString());
    expect(() =>
      insert.run('q-dup', 'session-B', 'msg-B', 'Q2', '[]', new Date().toISOString()),
    ).toThrow(/UNIQUE/);
  });

  it('INSERT OR IGNORE on duplicate question_id leaves the original row intact', () => {
    const db = getDb();

    const insert = db.prepare(`
      INSERT OR IGNORE INTO pending_questions
        (question_id, session_id, message_out_id, title, options_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insert.run('q-retry', 'session-C', 'msg-first', 'Original title', '[]', new Date().toISOString());
    insert.run('q-retry', 'session-C', 'msg-second', 'Retry title', '[]', new Date().toISOString());

    const row = db
      .prepare(`SELECT * FROM pending_questions WHERE question_id = ?`)
      .get('q-retry') as { title: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.title).toBe('Original title');
  });
});
