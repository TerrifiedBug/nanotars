import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  getAllAgentGroups,
  getMessagingGroupById,
  getWiringForAgentGroup,
} from './db/agent-groups.js';
import { ScheduledTask } from './types.js';

/** Map ScheduledTask DB rows to the snapshot format used by writeTasksSnapshot. */
export function mapTasksToSnapshot(tasks: ScheduledTask[]) {
  return tasks.map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
    model: t.model,
  }));
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
    model?: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  const tmpFile = tasksFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(filteredTasks, null, 2));
  fs.renameSync(tmpFile, tasksFile);
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Source `available_groups.json` rows from the new entity-model tables
 * (agent_groups + messaging_group_agents + messaging_groups), one row per
 * (agent_group, wiring) pair.
 *
 * Phase 4A note: previously the orchestrator built this list from chat
 * history (`getAllChats`) with `isRegistered` flagged from the legacy
 * `registered_groups` lookup. The accessor here sources from the new
 * entity model directly — every row produced is, by definition, wired,
 * so `isRegistered` is always true. Output JSON shape matches the legacy
 * `{jid, name, lastActivity, isRegistered}` contract so the container's
 * reader (`/workspace/ipc/available_groups.json`) doesn't break.
 *
 * Multi-wiring agents produce one row per wiring (per (agent, chat)
 * pair). Agents with no wiring are skipped.
 */
export function mapAgentGroupsToSnapshot(): AvailableGroup[] {
  const out: AvailableGroup[] = [];
  for (const ag of getAllAgentGroups()) {
    const wirings = getWiringForAgentGroup(ag.id);
    for (const w of wirings) {
      const mg = getMessagingGroupById(w.messaging_group_id);
      if (!mg) continue;
      out.push({
        jid: mg.platform_id,
        name: mg.name ?? ag.name,
        // The new entity model has no chat-history coupling. Use the
        // wiring's birth as the activity proxy; the container only uses
        // this field for ordering display, not for routing.
        lastActivity: w.created_at,
        isRegistered: true,
      });
    }
  }
  return out;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  const tmpFile = groupsFile + '.tmp';
  fs.writeFileSync(
    tmpFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpFile, groupsFile);
}
