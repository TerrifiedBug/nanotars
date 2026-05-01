import { createSchema, getDb, initDatabase } from '../../db/init.js';

let initialized = false;

export function initCliDatabase(): void {
  if (initialized) return;
  initDatabase();
  createSchema(getDb());
  initialized = true;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function parseGlobalFlags(args: string[]): { json: boolean; rest: string[] } {
  return {
    json: args.includes('--json'),
    rest: args.filter((arg) => arg !== '--json'),
  };
}
