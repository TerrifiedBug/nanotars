/**
 * `nanotars pair-main` — first-time bootstrap for the main control chat.
 *
 * Allocates a 4-digit pending pairing code with intent='main' and prints
 * it for the operator to send from the channel chat they want to register.
 * The channel plugin's inbound interceptor (`consumePendingCode`) finalises
 * the wiring on first match: creates the `messaging_groups` row + the
 * `messaging_group_agents` wiring, plus `groups/<MAIN_GROUP_FOLDER>/`.
 *
 * Channel-agnostic. Pass `--channel <name>` explicitly, or auto-detect
 * when exactly one channel plugin is installed under plugins/channels/.
 *
 * Idempotent: seeds `agent_groups[folder='main']` if absent, leaves it
 * untouched otherwise. Re-running issues a fresh code (the prior pending
 * code is still valid until consumed or expired).
 */
import fs from 'fs';
import path from 'path';

import { MAIN_GROUP_FOLDER } from '../config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import { createSchema, getDb, initDatabase } from '../db/init.js';
import { createPendingCode } from '../pending-codes.js';

const CHANNEL_PLUGINS_DIR = path.resolve(process.cwd(), 'plugins', 'channels');

interface CliArgs {
  channel?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a === '--channel') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(`--channel requires a value`);
      }
      args.channel = next;
      i++;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

interface ChannelPluginMeta {
  name: string;
}

/**
 * Scan plugins/channels/* for installed channel plugins. We only count an
 * entry if its plugin.json has `channelPlugin: true` — guards against stray
 * non-channel directories landing here.
 */
function listChannelPlugins(dir: string = CHANNEL_PLUGINS_DIR): ChannelPluginMeta[] {
  if (!fs.existsSync(dir)) return [];
  const out: ChannelPluginMeta[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginJsonPath = path.join(dir, entry.name, 'plugin.json');
    if (!fs.existsSync(pluginJsonPath)) continue;
    let meta: { name?: unknown; channelPlugin?: unknown };
    try {
      meta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8')) as typeof meta;
    } catch {
      continue;
    }
    if (meta.channelPlugin !== true) continue;
    const name = typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : entry.name;
    out.push({ name });
  }
  return out;
}

function printHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    [
      'Usage: nanotars pair-main [--channel <name>]',
      '',
      'Allocate a 4-digit pairing code that registers a chat as the main control chat.',
      'Send the code as a message from the chat you want to register; the bot will',
      'confirm the pair once it sees the digits.',
      '',
      'Options:',
      '  --channel <name>   Channel plugin to scope the code to.',
      '                     Default: auto-detect when exactly one channel is installed.',
      '  -h, --help         Show this help.',
      '',
    ].join('\n'),
  );
}

export interface PairMainResult {
  channel: string;
  code: string;
  expires_at: string | null;
  seededAgentGroup: boolean;
}

/**
 * Library entry point — exposed for the CLI script and the test suite.
 *
 * The DB connection is opened lazily; callers using `_initTestDatabase`
 * should NOT call `initDatabase()` themselves. Pass `skipDbInit: true`
 * to use whatever DB the caller already wired up.
 */
export async function runPairMain(opts: {
  channel?: string;
  channelPluginsDir?: string;
  skipDbInit?: boolean;
}): Promise<PairMainResult> {
  const channel = opts.channel ?? autoDetectChannel(opts.channelPluginsDir);

  if (!opts.skipDbInit) {
    initDatabase();
    createSchema(getDb());
  }

  let seededAgentGroup = false;
  if (!getAgentGroupByFolder(MAIN_GROUP_FOLDER)) {
    createAgentGroup({ name: 'Main', folder: MAIN_GROUP_FOLDER });
    seededAgentGroup = true;
  }

  const result = await createPendingCode({ channel, intent: 'main' });
  return {
    channel,
    code: result.code,
    expires_at: result.expires_at,
    seededAgentGroup,
  };
}

function autoDetectChannel(dirOverride?: string): string {
  const installed = listChannelPlugins(dirOverride);
  if (installed.length === 0) {
    throw new Error(
      'no channel plugins installed under plugins/channels/. ' +
        'Install one first (e.g. via /add-channel-telegram) and re-run.',
    );
  }
  if (installed.length > 1) {
    const names = installed.map((p) => p.name).join(', ');
    throw new Error(
      `multiple channel plugins installed (${names}). Pass --channel <name> to choose one.`,
    );
  }
  return installed[0].name;
}

async function cli(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`pair-main: ${(err as Error).message}\n\n`);
    printHelp(process.stderr);
    return 64; // EX_USAGE
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  let result: PairMainResult;
  try {
    result = await runPairMain({ channel: args.channel });
  } catch (err) {
    process.stderr.write(`pair-main: ${(err as Error).message}\n`);
    return 1;
  }

  if (result.seededAgentGroup) {
    process.stdout.write(`Seeded agent_groups[folder='${MAIN_GROUP_FOLDER}'].\n`);
  }

  const expiry = result.expires_at ?? 'never';
  process.stdout.write(
    [
      '',
      `  Pairing code: ${result.code}`,
      '',
      `  Send these 4 digits as a message in the ${result.channel} chat you want to`,
      '  register as your main control chat. The bot will confirm the pair once it',
      '  sees the code.',
      '',
      `  Code expires: ${expiry}`,
      '',
    ].join('\n'),
  );
  return 0;
}

// CLI entrypoint guard. When this module is imported (e.g. by tests) the
// runtime block below is skipped — only direct `node dist/cli/pair-main.js`
// invocations end up here.
const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  cli()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`pair-main: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(2);
    });
}
