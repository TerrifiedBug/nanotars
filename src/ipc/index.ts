import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
} from '../config.js';
import { logger } from '../logger.js';
import { listIpcJsonFiles, quarantineFile, readIpcJsonFile } from './file-io.js';
import { processMessageIpc } from './messages.js';
import { processTaskIpc } from './tasks.js';
import { IpcDeps, isIpcMessage, isValidTaskIpc } from './types.js';

export type { IpcDeps, IpcMessage } from './types.js';
export { processTaskIpc } from './tasks.js';
export { processMessageIpc } from './messages.js';

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): Promise<void> {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return Promise.resolve();
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      const entries = await fs.promises.readdir(ipcBaseDir, { withFileTypes: true });
      groupFolders = entries
        .filter((entry) => entry.isDirectory() && entry.name !== 'errors')
        .map((entry) => entry.name);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        {
          const messageFiles = await listIpcJsonFiles(messagesDir);
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const raw = await readIpcJsonFile(filePath, sourceGroup);
              if (raw === null) {
                quarantineFile(filePath, sourceGroup, file, ipcBaseDir);
                continue;
              }
              if (!isIpcMessage(raw)) {
                logger.warn({ filePath, sourceGroup, type: (raw as Record<string, unknown>)?.type }, 'IPC: invalid message format');
                quarantineFile(filePath, sourceGroup, file, ipcBaseDir);
                continue;
              }
              await processMessageIpc(raw, sourceGroup, isMain, registeredGroups, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              quarantineFile(filePath, sourceGroup, file, ipcBaseDir);
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        {
          const taskFiles = await listIpcJsonFiles(tasksDir);
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = await readIpcJsonFile(filePath, sourceGroup);
              if (data === null) {
                quarantineFile(filePath, sourceGroup, file, ipcBaseDir);
                continue;
              }
              if (!isValidTaskIpc(data)) {
                logger.warn(
                  { filePath, sourceGroup, type: (data as Record<string, unknown>)?.type },
                  'IPC: invalid task format — unknown or missing type',
                );
                quarantineFile(filePath, sourceGroup, file, ipcBaseDir);
                continue;
              }
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data as any, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
              quarantineFile(filePath, sourceGroup, file, ipcBaseDir);
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  const firstRun = processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
  return firstRun;
}
