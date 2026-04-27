/**
 * Slice 5 — write the ADMIN_COMMANDS metadata Map to a JSON file on
 * host boot. Channel plugins read it on connect to populate their own
 * command-autocomplete surfaces (e.g. Telegram's setMyCommands).
 *
 * Atomic write: tmp file in the same directory, then rename. The OS
 * rename guarantees readers never observe a partial file.
 */
import fs from 'fs';
import path from 'path';

import { listAdminCommands } from './command-gate.js';

export const ADMIN_COMMANDS_JSON_FILENAME = 'admin-commands.json';

/**
 * Serialise the ADMIN_COMMANDS metadata to `<dataDir>/admin-commands.json`.
 * The file content is an array of `{ name, description, usage }` objects
 * sorted by name, matching `listAdminCommands()`.
 *
 * Idempotent: subsequent calls overwrite the file. Safe to call multiple
 * times during boot (e.g. after a hot reload).
 */
export function writeAdminCommandsJson(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, ADMIN_COMMANDS_JSON_FILENAME);
  const tmp = `${target}.${process.pid}.tmp`;
  const payload = listAdminCommands().map((meta) => ({
    name: meta.name,
    description: meta.description,
    usage: meta.usage,
  }));
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}
