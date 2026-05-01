import { getRuntimeSummary, listRuntimeContainers } from '../../db/runtime.js';
import { initCliDatabase, parseGlobalFlags, printJson } from './common.js';

export async function runtimeCommand(args: string[]): Promise<number> {
  const { json, rest } = parseGlobalFlags(args);
  const [subcommand, ...subArgs] = rest;
  initCliDatabase();

  switch (subcommand ?? 'status') {
    case 'status':
      return runtimeStatus(json);
    case 'containers':
    case 'list':
      return runtimeContainers(subArgs, json);
    case '-h':
    case '--help':
    case 'help':
      runtimeHelp();
      return 0;
    default:
      process.stderr.write(`runtime: unknown command '${subcommand}'\n\n`);
      runtimeHelp(process.stderr);
      return 64;
  }
}

function runtimeStatus(json: boolean): number {
  const summary = getRuntimeSummary();
  if (json) {
    printJson(summary);
    return 0;
  }
  process.stdout.write(`active containers: ${summary.active}\n`);
  process.stdout.write(`recent failures: ${summary.recent_failures}\n`);
  if (summary.latest.length === 0) {
    process.stdout.write('latest: (none)\n');
    return 0;
  }
  process.stdout.write('latest:\n');
  for (const row of summary.latest) {
    process.stdout.write(
      `  ${row.status.padEnd(11)} ${row.group_folder.padEnd(18)} ${row.reason} ${row.updated_at}\n`,
    );
  }
  return 0;
}

function runtimeContainers(args: string[], json: boolean): number {
  const activeOnly = args.includes('--active');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 25;
  const rows = listRuntimeContainers({ activeOnly, limit: Number.isFinite(limit) ? limit : 25 });
  if (json) {
    printJson(rows);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write('(none)\n');
    return 0;
  }
  for (const row of rows) {
    const exit = row.exit_code === null ? '' : ` exit=${row.exit_code}`;
    const task = row.task_id ? ` task=${row.task_id}` : '';
    process.stdout.write(`${row.status.padEnd(11)} ${row.group_folder.padEnd(18)} ${row.container_name}${exit}${task}\n`);
  }
  return 0;
}

function runtimeHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    [
      'Usage: nanotars runtime <status|containers> [--json]',
      '',
      'Commands:',
      '  status                 Summarize runtime/container activity',
      '  containers [--active]  List recent runtime container rows',
      '',
    ].join('\n'),
  );
}
