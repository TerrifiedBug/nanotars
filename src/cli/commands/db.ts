import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

interface DbMaintenanceOptions {
  apply: boolean;
  messageDays: number;
  taskLogDays: number;
  backupRetention: number;
}

interface RowCount {
  table_name: string;
  row_count: number;
}

export async function dbCommand(args: string[], projectRoot: string): Promise<number> {
  const [subcommand, ...rest] = args;
  const dbPath = path.join(projectRoot, 'store', 'messages.db');

  switch (subcommand ?? 'stats') {
    case 'stats':
      return withDb(dbPath, (db) => printStats(db, dbPath));
    case 'integrity':
      return withDb(dbPath, (db) => integrity(db));
    case 'maintenance':
    case 'maintain':
      return withDb(dbPath, (db) => maintenance(db, dbPath, parseMaintenanceArgs(rest)));
    case '-h':
    case '--help':
    case 'help':
      dbHelp();
      return 0;
    default:
      process.stderr.write(`db: unknown command '${subcommand}'\n\n`);
      dbHelp(process.stderr);
      return 64;
  }
}

async function withDb(
  dbPath: string,
  fn: (db: Database.Database) => number | Promise<number>,
): Promise<number> {
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`db: ${dbPath} not found\n`);
    return 1;
  }
  const db = new Database(dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function printStats(db: Database.Database, dbPath: string): number {
  for (const row of getStats(db)) {
    process.stdout.write(`${row.table_name}: ${row.row_count}\n`);
  }
  process.stdout.write(`size: ${formatBytes(fs.statSync(dbPath).size)}\n`);
  return 0;
}

function integrity(db: Database.Database): number {
  const result = db.prepare('PRAGMA integrity_check').pluck().get() as string;
  process.stdout.write(`integrity: ${result}\n`);
  return result === 'ok' ? 0 : 1;
}

async function maintenance(
  db: Database.Database,
  dbPath: string,
  opts: DbMaintenanceOptions | string,
): Promise<number> {
  if (typeof opts === 'string') {
    process.stderr.write(`${opts}\n\n`);
    dbHelp(process.stderr);
    return 64;
  }

  process.stdout.write('before:\n');
  for (const row of getStats(db)) process.stdout.write(`  ${row.table_name}: ${row.row_count}\n`);
  process.stdout.write(`  size: ${formatBytes(fs.statSync(dbPath).size)}\n`);

  const integrityResult = db.prepare('PRAGMA integrity_check').pluck().get() as string;
  process.stdout.write(`integrity: ${integrityResult}\n`);
  if (integrityResult !== 'ok') {
    process.stderr.write('db maintenance: integrity check failed; refusing to continue\n');
    return 1;
  }

  if (!opts.apply) {
    process.stdout.write('dry-run: pass --apply to create a backup, prune old rows, analyze, and vacuum\n');
    process.stdout.write(`would prune task_run_logs older than ${opts.taskLogDays} days\n`);
    process.stdout.write(`would prune messages older than ${opts.messageDays} days\n`);
    return 0;
  }

  const backupPath = await backupDatabaseFile(db, dbPath, opts.backupRetention);
  process.stdout.write(`backup: ${backupPath}\n`);

  const prune = db.transaction(() => {
    const taskLogsDeleted = db
      .prepare(`DELETE FROM task_run_logs WHERE run_at < datetime('now', ?)`)
      .run(`-${opts.taskLogDays} days`).changes;
    const messagesDeleted = db
      .prepare(`DELETE FROM messages WHERE timestamp < datetime('now', ?)`)
      .run(`-${opts.messageDays} days`).changes;
    return { taskLogsDeleted, messagesDeleted };
  });
  const { taskLogsDeleted, messagesDeleted } = prune();
  process.stdout.write(`deleted task_run_logs: ${taskLogsDeleted}\n`);
  process.stdout.write(`deleted messages: ${messagesDeleted}\n`);

  db.exec('ANALYZE');
  db.exec('VACUUM');

  process.stdout.write('after:\n');
  for (const row of getStats(db)) process.stdout.write(`  ${row.table_name}: ${row.row_count}\n`);
  process.stdout.write(`  size: ${formatBytes(fs.statSync(dbPath).size)}\n`);
  return 0;
}

function getStats(db: Database.Database): RowCount[] {
  return db
    .prepare(
      `
      SELECT 'Messages' as table_name, COUNT(*) as row_count FROM messages
      UNION ALL SELECT 'Chats', COUNT(*) FROM chats
      UNION ALL SELECT 'Scheduled Tasks', COUNT(*) FROM scheduled_tasks
      UNION ALL SELECT 'Task Run Logs', COUNT(*) FROM task_run_logs
      UNION ALL SELECT 'Sessions', COUNT(*) FROM sessions
      `,
    )
    .all() as RowCount[];
}

async function backupDatabaseFile(
  db: Database.Database,
  dbPath: string,
  retention: number,
): Promise<string> {
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `messages-${timestamp}.db`);
  await db.backup(backupPath);

  const backups = fs
    .readdirSync(backupDir)
    .filter((file) => file.startsWith('messages-') && file.endsWith('.db'))
    .sort()
    .reverse();
  for (const old of backups.slice(retention)) {
    fs.rmSync(path.join(backupDir, old), { force: true });
  }
  return backupPath;
}

function parseMaintenanceArgs(args: string[]): DbMaintenanceOptions | string {
  const opts: DbMaintenanceOptions = {
    apply: false,
    messageDays: 90,
    taskLogDays: 30,
    backupRetention: 3,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--message-days') {
      const parsed = parsePositiveInt(args[++i], arg);
      if (typeof parsed === 'string') return parsed;
      opts.messageDays = parsed;
    } else if (arg === '--task-log-days') {
      const parsed = parsePositiveInt(args[++i], arg);
      if (typeof parsed === 'string') return parsed;
      opts.taskLogDays = parsed;
    } else if (arg === '--backup-retention') {
      const parsed = parsePositiveInt(args[++i], arg);
      if (typeof parsed === 'string') return parsed;
      opts.backupRetention = parsed;
    } else {
      return `db maintenance: unknown argument '${arg}'`;
    }
  }
  return opts;
}

function parsePositiveInt(value: string | undefined, flag: string): number | string {
  if (!value) return `${flag} requires a value`;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return `${flag} must be a positive integer`;
  return parsed;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function dbHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    [
      'Usage: nanotars db <command>',
      '',
      'Commands:',
      '  stats                         Show database row counts and size',
      '  integrity                     Run PRAGMA integrity_check',
      '  maintenance [options]         Backup, prune old rows, analyze, vacuum',
      '',
      'Maintenance options:',
      '  --apply                       Perform changes; omitted means dry-run',
      '  --message-days <days>         Retain messages this many days (default 90)',
      '  --task-log-days <days>        Retain task logs this many days (default 30)',
      '  --backup-retention <count>    Keep this many backups (default 3)',
      '',
    ].join('\n'),
  );
}
