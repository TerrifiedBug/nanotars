import fs from 'fs';
import path from 'path';

const KNOWN_MODELS = new Map([
  ['sonnet', 'claude-sonnet-4-5'],
  ['claude-sonnet-4-5', 'claude-sonnet-4-5'],
  ['opus', 'claude-opus-4-6'],
  ['claude-opus-4-6', 'claude-opus-4-6'],
  ['haiku', 'claude-haiku-4-5'],
  ['claude-haiku-4-5', 'claude-haiku-4-5'],
]);

export async function modelCommand(args: string[], projectRoot: string): Promise<number> {
  const [subcommand, ...rest] = args;
  const modelFile = path.join(projectRoot, 'store', 'claude-model');

  switch (subcommand ?? 'get') {
    case 'get':
    case 'show':
      return showModel(modelFile);
    case 'set':
      return setModel(modelFile, rest);
    case 'reset':
    case 'unset':
      return resetModel(modelFile);
    case '-h':
    case '--help':
    case 'help':
      modelHelp();
      return 0;
    default:
      process.stderr.write(`model: unknown command '${subcommand}'\n\n`);
      modelHelp(process.stderr);
      return 64;
  }
}

function showModel(modelFile: string): number {
  if (!fs.existsSync(modelFile)) {
    process.stdout.write('model: default (SDK default)\n');
    return 0;
  }
  process.stdout.write(`model: ${fs.readFileSync(modelFile, 'utf8').trim()}\n`);
  return 0;
}

function setModel(modelFile: string, args: string[]): number {
  const requested = args[0];
  if (!requested) {
    process.stderr.write('model set: missing model id\n\n');
    modelHelp(process.stderr);
    return 64;
  }
  const model = KNOWN_MODELS.get(requested);
  if (!model) {
    process.stderr.write(`model set: unknown model '${requested}'\n`);
    process.stderr.write(`known models: ${[...KNOWN_MODELS.keys()].join(', ')}\n`);
    return 64;
  }
  fs.mkdirSync(path.dirname(modelFile), { recursive: true });
  atomicWriteFile(modelFile, `${model}\n`);
  process.stdout.write(`model: ${model}\n`);
  return 0;
}

function resetModel(modelFile: string): number {
  fs.rmSync(modelFile, { force: true });
  process.stdout.write('model: default (SDK default)\n');
  return 0;
}

function atomicWriteFile(file: string, contents: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function modelHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    [
      'Usage: nanotars model <command>',
      '',
      'Commands:',
      '  get                 Show the configured model',
      '  set <model>         Set model: sonnet, opus, haiku, or full model id',
      '  reset               Remove override and use the SDK default',
      '',
    ].join('\n'),
  );
}
