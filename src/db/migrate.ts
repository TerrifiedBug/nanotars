import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  createAgentGroup,
  createMessagingGroup,
  createWiring,
  getAgentGroupByFolder,
  getMessagingGroup,
  getWiring,
} from './agent-groups.js';
import { setRouterState, setSession } from './state.js';
import { pruneTaskRunLogs } from './tasks.js';

/**
 * Legacy JSON shape — preserved here verbatim because we only ever read it
 * to migrate. Once `registered_groups.json.migrated` exists on a host this
 * branch never executes again. Mirrors the v1 `RegisteredGroup` interface
 * minus the entity-model fields A1 introduced. Keep the field list in sync
 * with what the JSON file actually contained on disk.
 */
interface LegacyRegisteredGroupJson {
  name: string;
  folder: string;
  pattern?: string;
  trigger_pattern?: string; // pre-007 column name
  added_at: string;
  channel?: string;
  containerConfig?: unknown; // serialized later as JSON
  engage_mode?: 'pattern' | 'always' | 'mention-sticky';
  sender_scope?: 'all' | 'known';
  ignored_message_policy?: 'drop' | 'observe';
  requires_trigger?: boolean; // pre-007 column
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json into the entity-model tables
  // (agent_groups + messaging_groups + messaging_group_agents).
  // The legacy registered_groups table is no longer the source of truth, so
  // routing through setRegisteredGroup would lose these rows on the next
  // process restart. Idempotent on (channel, jid), (folder), and on the
  // wiring tuple — re-running the migration is a no-op.
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    LegacyRegisteredGroupJson
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      // 'whatsapp' was the only channel that ever wrote this JSON file in
      // v0/v1 — there was no channel column on disk before SQLite landed.
      const channel = group.channel ?? 'whatsapp';
      const engagePattern = group.pattern ?? group.trigger_pattern ?? null;
      const engage_mode =
        group.engage_mode ??
        (group.requires_trigger === false ? 'always' : 'pattern');
      let containerConfigJson: string | null = null;
      if (group.containerConfig !== undefined && group.containerConfig !== null) {
        try {
          containerConfigJson = JSON.stringify(group.containerConfig);
        } catch {
          containerConfigJson = null;
        }
      }

      let mg = getMessagingGroup(channel, jid);
      if (!mg) {
        mg = createMessagingGroup({
          channel_type: channel,
          platform_id: jid,
          name: null,
        });
      }
      let ag = getAgentGroupByFolder(group.folder);
      if (!ag) {
        ag = createAgentGroup({
          name: group.name,
          folder: group.folder,
          container_config: containerConfigJson,
        });
      }
      if (!getWiring(mg.id, ag.id)) {
        createWiring({
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode,
          engage_pattern: engagePattern,
          sender_scope: group.sender_scope ?? 'all',
          ignored_message_policy: group.ignored_message_policy ?? 'drop',
        });
      }
    }
  }
}

/**
 * Run post-schema startup tasks: JSON migration and log pruning.
 * Called from initDatabase() after schema is ready.
 */
export function runStartupTasks(): void {
  // Migrate from JSON files if they exist
  migrateJsonState();

  // Prune old task run logs
  const pruned = pruneTaskRunLogs();
  if (pruned > 0) {
    logger.info({ pruned }, 'Pruned old task run logs');
  }
}
