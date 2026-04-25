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
    recordUnregisteredSender('whatsapp', '447777777777@s.whatsapp.net', 'Jane', db);
    const rows = listUnregisteredSenders(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'whatsapp', platform_id: '447777777777@s.whatsapp.net', sender_name: 'Jane', count: 1 });
  });

  it('coalesces repeated sightings (count++ + last_seen update)', () => {
    recordUnregisteredSender('whatsapp', '447777777777@s.whatsapp.net', 'Jane', db);
    recordUnregisteredSender('whatsapp', '447777777777@s.whatsapp.net', 'Jane', db);
    recordUnregisteredSender('whatsapp', '447777777777@s.whatsapp.net', 'Jane', db);
    const rows = listUnregisteredSenders(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
  });

  it('treats different (channel, platform_id) pairs as separate rows', () => {
    recordUnregisteredSender('whatsapp', 'a@s.whatsapp.net', 'A', db);
    recordUnregisteredSender('discord', 'a@s.whatsapp.net', 'A', db);
    recordUnregisteredSender('whatsapp', 'b@s.whatsapp.net', 'B', db);
    expect(listUnregisteredSenders(db)).toHaveLength(3);
  });

  it('clearUnregisteredSender removes the row', () => {
    recordUnregisteredSender('whatsapp', 'a@s.whatsapp.net', 'A', db);
    clearUnregisteredSender('whatsapp', 'a@s.whatsapp.net', db);
    expect(listUnregisteredSenders(db)).toHaveLength(0);
  });

  it('updates sender_name to the most-recent observed name', () => {
    recordUnregisteredSender('whatsapp', 'a@s.whatsapp.net', 'OldName', db);
    recordUnregisteredSender('whatsapp', 'a@s.whatsapp.net', 'NewName', db);
    const rows = listUnregisteredSenders(db);
    expect(rows[0].sender_name).toBe('NewName');
  });
});
