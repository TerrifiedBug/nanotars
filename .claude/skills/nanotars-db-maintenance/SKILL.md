---
name: nanotars-db-maintenance
description: Run SQLite database maintenance — vacuum, integrity check, prune old data, report statistics
triggers:
  - db maintenance
  - database maintenance
  - vacuum database
  - clean database
  - database health
---

# Database Maintenance

Use the typed NanoTars CLI. Do not run raw `sqlite3` maintenance snippets from this skill.

The CLI owns backup, integrity check, pruning, `ANALYZE`, and `VACUUM` behavior for `store/messages.db`.

## Read-Only Checks

Show row counts and file size:

```bash
nanotars db stats
```

Run integrity check:

```bash
nanotars db integrity
```

Preview maintenance without changing anything:

```bash
nanotars db maintenance
```

## Apply Maintenance

Ask the operator to confirm retention windows before applying. Defaults are:

- messages: retain 90 days
- task run logs: retain 30 days
- backups: retain 3 latest backups

Run:

```bash
nanotars db maintenance --apply
```

Custom retention:

```bash
nanotars db maintenance --apply --message-days 90 --task-log-days 30 --backup-retention 3
```

The apply path creates a SQLite backup first, then prunes old append-only data, runs `ANALYZE`, and runs `VACUUM`.
