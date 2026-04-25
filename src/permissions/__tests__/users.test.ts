import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../../db/init.js';
import { ensureUser, getUserById, listUsersByKind } from '../users.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('ensureUser', () => {
  it('creates a new row and returns a User with the input id', () => {
    const user = ensureUser({ id: 'telegram:alice', kind: 'telegram', display_name: 'Alice' });
    expect(user.id).toBe('telegram:alice');
    expect(user.kind).toBe('telegram');
    expect(user.display_name).toBe('Alice');
    expect(user.created_at).toBeTruthy();
  });

  it('is idempotent: second call with same id returns the existing row', () => {
    const first = ensureUser({ id: 'telegram:bob', kind: 'telegram', display_name: 'Bob' });
    const second = ensureUser({ id: 'telegram:bob', kind: 'telegram', display_name: 'Bob' });
    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
  });

  it('updates display_name when provided and different from existing', () => {
    ensureUser({ id: 'telegram:carol', kind: 'telegram', display_name: 'Carol' });
    const updated = ensureUser({ id: 'telegram:carol', kind: 'telegram', display_name: 'Caroline' });
    expect(updated.display_name).toBe('Caroline');

    // Verify the update is persisted
    const fetched = getUserById('telegram:carol');
    expect(fetched!.display_name).toBe('Caroline');
  });

  it('preserves existing display_name when display_name is not provided', () => {
    ensureUser({ id: 'telegram:dave', kind: 'telegram', display_name: 'Dave' });
    // Call without display_name — should not change the existing value
    const result = ensureUser({ id: 'telegram:dave', kind: 'telegram' });
    expect(result.display_name).toBe('Dave');
  });

  it('stores null display_name when not provided on creation', () => {
    const user = ensureUser({ id: 'telegram:eve', kind: 'telegram' });
    expect(user.display_name).toBeNull();
  });
});

describe('getUserById', () => {
  it('round-trips: returns the same user after ensureUser', () => {
    const created = ensureUser({ id: 'discord:frank', kind: 'discord', display_name: 'Frank' });
    const found = getUserById('discord:frank');
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.kind).toBe('discord');
    expect(found!.display_name).toBe('Frank');
    expect(found!.created_at).toBe(created.created_at);
  });

  it('returns undefined for an unknown id', () => {
    expect(getUserById('telegram:nobody')).toBeUndefined();
  });
});

describe('listUsersByKind', () => {
  it('returns only users of the matching kind', () => {
    ensureUser({ id: 'telegram:u1', kind: 'telegram' });
    ensureUser({ id: 'discord:u2', kind: 'discord' });
    ensureUser({ id: 'telegram:u3', kind: 'telegram' });

    const telegramUsers = listUsersByKind('telegram');
    expect(telegramUsers).toHaveLength(2);
    const ids = telegramUsers.map((u) => u.id);
    expect(ids).toContain('telegram:u1');
    expect(ids).toContain('telegram:u3');
    expect(ids).not.toContain('discord:u2');
  });

  it('returns results ordered by created_at', () => {
    ensureUser({ id: 'telegram:a', kind: 'telegram' });
    ensureUser({ id: 'telegram:b', kind: 'telegram' });
    ensureUser({ id: 'telegram:c', kind: 'telegram' });

    const users = listUsersByKind('telegram');
    expect(users).toHaveLength(3);
    // created_at should be non-decreasing
    for (let i = 1; i < users.length; i++) {
      expect(users[i].created_at >= users[i - 1].created_at).toBe(true);
    }
  });

  it('returns empty array when no users of that kind exist', () => {
    ensureUser({ id: 'discord:u1', kind: 'discord' });
    expect(listUsersByKind('slack')).toEqual([]);
  });
});
