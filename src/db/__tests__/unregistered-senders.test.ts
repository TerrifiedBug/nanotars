import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../init.js';
import { recordUnregisteredSender, listUnregisteredSenders, clearUnregisteredSender } from '../unregistered-senders.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createSchema(db);
});

describe('unregistered-senders accessor', () => {
  it('records the first sighting of a sender', () => {
    recordUnregisteredSender(db, 'whatsapp', '447777777777@s.whatsapp.net', 'Jane');
    const rows = listUnregisteredSenders(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'whatsapp', platform_id: '447777777777@s.whatsapp.net', sender_name: 'Jane', count: 1 });
  });

  it('coalesces repeated sightings (count++ + last_seen update)', () => {
    recordUnregisteredSender(db, 'whatsapp', '447777777777@s.whatsapp.net', 'Jane');
    recordUnregisteredSender(db, 'whatsapp', '447777777777@s.whatsapp.net', 'Jane');
    recordUnregisteredSender(db, 'whatsapp', '447777777777@s.whatsapp.net', 'Jane');
    const rows = listUnregisteredSenders(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
  });

  it('treats different (channel, platform_id) pairs as separate rows', () => {
    recordUnregisteredSender(db, 'whatsapp', 'a@s.whatsapp.net', 'A');
    recordUnregisteredSender(db, 'discord', 'a@s.whatsapp.net', 'A');
    recordUnregisteredSender(db, 'whatsapp', 'b@s.whatsapp.net', 'B');
    expect(listUnregisteredSenders(db)).toHaveLength(3);
  });

  it('clearUnregisteredSender removes the row', () => {
    recordUnregisteredSender(db, 'whatsapp', 'a@s.whatsapp.net', 'A');
    clearUnregisteredSender(db, 'whatsapp', 'a@s.whatsapp.net');
    expect(listUnregisteredSenders(db)).toHaveLength(0);
  });

  it('updates sender_name to the most-recent observed name', () => {
    recordUnregisteredSender(db, 'whatsapp', 'a@s.whatsapp.net', 'OldName');
    recordUnregisteredSender(db, 'whatsapp', 'a@s.whatsapp.net', 'NewName');
    const rows = listUnregisteredSenders(db);
    expect(rows[0].sender_name).toBe('NewName');
  });
});
