import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

/** Max IPC JSON file size (1 MiB — generous for any valid command) */
export const IPC_MAX_FILE_SIZE = 1024 * 1024;

/**
 * Safely read an IPC JSON file:
 *  - lstat to reject symlinks (CWE-59)
 *  - size limit to prevent DoS
 *  - O_NOFOLLOW to prevent TOCTOU race between lstat and open
 * Returns parsed JSON or null on any issue.
 */
export async function readIpcJsonFile(filePath: string, sourceGroup: string): Promise<unknown | null> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile()) {
      logger.warn({ filePath, sourceGroup }, 'IPC: not a regular file, skipping');
      return null;
    }
    if (stat.size > IPC_MAX_FILE_SIZE) {
      logger.warn({ filePath, size: stat.size, sourceGroup }, 'IPC: file too large, skipping');
      return null;
    }
    // O_NOFOLLOW prevents symlink race between lstat and open
    const fd = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(stat.size);
      const { bytesRead } = await fd.read(buf, 0, stat.size, 0);
      return JSON.parse(buf.slice(0, bytesRead).toString('utf-8'));
    } finally {
      await fd.close();
    }
  } catch (err) {
    logger.warn({ filePath, sourceGroup, err }, 'IPC: failed to read file safely');
    return null;
  }
}

/**
 * List .json files in an IPC directory, filtering to regular files only.
 * Uses withFileTypes to avoid stat on non-files (directory entry type confusion).
 */
export async function listIpcJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Move a failed IPC file to the errors directory. */
export function quarantineFile(filePath: string, sourceGroup: string, fileName: string, ipcBaseDir: string): void {
  const errorDir = path.join(ipcBaseDir, 'errors');
  fs.mkdirSync(errorDir, { recursive: true });
  fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${fileName}`));
}
