import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { isAuthorizedForJid } from './auth.js';
import { IpcDeps, IpcMessage } from './types.js';

/** Max file size for send_file (64 MB) */
const SEND_FILE_MAX_SIZE = 64 * 1024 * 1024;

/** Infer MIME type from file extension */
function mimeFromExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.pdf': 'application/pdf', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

export async function processMessageIpc(
  data: IpcMessage,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): Promise<void> {
  switch (data.type) {
    case 'message': {
      if (!isAuthorizedForJid(data.chatJid, registeredGroups, sourceGroup, isMain, 'message')) break;
      await deps.sendMessage(data.chatJid, data.text, data.sender, data.replyTo);
      logger.info(
        { chatJid: data.chatJid, sourceGroup },
        'IPC message sent',
      );
      break;
    }
    case 'send_file': {
      if (!isAuthorizedForJid(data.chatJid, registeredGroups, sourceGroup, isMain, 'send_file')) break;
      // Translate container path to host path
      // Container /workspace/group/... → host groups/{folder}/...
      let hostPath = data.filePath;
      if (hostPath.startsWith('/workspace/group/')) {
        hostPath = path.join(GROUPS_DIR, sourceGroup, hostPath.slice('/workspace/group/'.length));
      }

      // Prevent path traversal: resolved path must stay within the group directory
      const groupRoot = path.resolve(path.join(GROUPS_DIR, sourceGroup));
      const resolvedHost = path.resolve(hostPath);
      if (!resolvedHost.startsWith(groupRoot + path.sep) && resolvedHost !== groupRoot) {
        logger.warn({ hostPath, resolvedHost, groupRoot, sourceGroup }, 'send_file: path traversal blocked');
        break;
      }

      if (!fs.existsSync(hostPath)) {
        logger.warn({ hostPath, sourceGroup }, 'send_file: file not found');
      } else {
        // Resolve symlinks and re-check containment (path.resolve doesn't follow symlinks)
        const realHost = fs.realpathSync(hostPath);
        const realGroup = fs.realpathSync(path.join(GROUPS_DIR, sourceGroup));
        if (!realHost.startsWith(realGroup + path.sep) && realHost !== realGroup) {
          logger.warn({ hostPath, realHost, realGroup, sourceGroup }, 'send_file: symlink traversal blocked');
          break;
        }
        const stat = fs.statSync(hostPath);
        if (!stat.isFile()) {
          logger.warn({ hostPath, sourceGroup }, 'send_file: not a regular file');
        } else if (stat.size > SEND_FILE_MAX_SIZE) {
          logger.warn({ hostPath, size: stat.size, sourceGroup }, 'send_file: file too large (64MB limit)');
        } else {
          const buffer = fs.readFileSync(hostPath);
          const mime = mimeFromExtension(hostPath);
          const fileName = data.fileName || path.basename(hostPath);
          const caption = data.caption;
          await deps.sendFile(data.chatJid, buffer, mime, fileName, caption);
          logger.info(
            { chatJid: data.chatJid, fileName, mime, size: stat.size, sourceGroup },
            'IPC file sent',
          );
        }
      }
      break;
    }
    case 'react': {
      if (!isAuthorizedForJid(data.chatJid, registeredGroups, sourceGroup, isMain, 'react')) break;
      await deps.react(data.chatJid, data.messageId, data.emoji);
      logger.info(
        { chatJid: data.chatJid, messageId: data.messageId, sourceGroup },
        'IPC react sent',
      );
      break;
    }
  }
}
