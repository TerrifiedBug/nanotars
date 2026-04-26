/**
 * Phase 5E — host-side handler for the `create_agent` IPC task emitted by
 * the container's admin-only `create_agent` MCP tool.
 *
 * Flow:
 *   1. Resolve the calling (parent) agent group from `groupFolder`.
 *   2. Re-validate that the sender is an admin (owner / global admin /
 *      scoped admin of the parent group). If sender threading is not yet
 *      complete on this IPC path, fall back to the same `isMain` heuristic
 *      used by `lifecycle-handlers.ts` (Phase 5D pattern).
 *   3. Validate name + folder, slugify when no folder is supplied, and
 *      probe for collisions (append `-2`, `-3`, ... suffixes).
 *   4. Insert the new `agent_groups` row.
 *   5. Scaffold the on-disk layout via `initGroupFilesystem`.
 *   6. Add the calling user as an explicit member of the new group so the
 *      agent owner can interact with it under `sender_scope='known'` later.
 *   7. Notify the calling agent (best-effort logger.warn stub today —
 *      same pattern as approvals).
 *
 * Wiring (messaging_group → agent_group) is intentionally NOT performed
 * here. The spec calls for the operator to run `/wire` afterwards so that
 * channel attachment stays an explicit, audited step. The new agent will
 * not receive any messages until then.
 *
 * Rollback: if `initGroupFilesystem` throws after the DB row is inserted,
 * we surface the error via notifyAgent and leave the row in place. v1
 * lacks a transactional cross-tier rollback path; the operator can clean
 * up via the DB or by re-running create_agent with a different folder.
 */
import { GROUPS_DIR } from '../config.js';
import {
  createAgentGroup,
  getAgentGroupByFolder,
} from '../db/agent-groups.js';
import { isValidGroupFolder } from '../db/state.js';
import { initGroupFilesystem } from '../group-init.js';
import { logger } from '../logger.js';
import { resolveProviderName } from '../providers/provider-container-registry.js';
import type { CreateAgentTask } from '../ipc/types.js';
import { addMember } from './agent-group-members.js';
import { notifyAgent } from './approval-primitive.js';
import {
  isAdminOfAgentGroup,
  isGlobalAdmin,
  isOwner,
} from './user-roles.js';

const FOLDER_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_MAX = 64;
const FOLDER_MAX = 64;
/**
 * Cap collision-suffix probes. Exceeding this is almost certainly a bug
 * (or an attacker grinding); fail loud rather than spinning forever.
 */
const FOLDER_SUFFIX_LIMIT = 100;

/** Slugify a name into a candidate folder. Lowercased, hyphenated, capped. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, FOLDER_MAX);
}

/**
 * Resolve whether the caller is allowed to create an agent. Mirrors
 * lifecycle-handlers.ts's pattern: strict role check when senderUserId is
 * threaded, isMain fallback otherwise.
 */
function isAdminCaller(
  senderUserId: string | undefined,
  isMain: boolean,
  parentAgentGroupId: string,
): boolean {
  if (senderUserId) {
    return (
      isOwner(senderUserId) ||
      isGlobalAdmin(senderUserId) ||
      isAdminOfAgentGroup(senderUserId, parentAgentGroupId)
    );
  }
  // Legacy fallback while sender threading is incomplete — see file
  // header in lifecycle-handlers.ts. Identical pattern keeps both
  // admin-action paths in sync.
  return isMain;
}

export async function handleCreateAgent(
  task: Pick<
    CreateAgentTask,
    'name' | 'instructions' | 'folder' | 'groupFolder' | 'isMain'
  >,
  senderUserId: string | undefined,
): Promise<void> {
  const callerAg = getAgentGroupByFolder(task.groupFolder);
  if (!callerAg) {
    logger.warn(
      { folder: task.groupFolder },
      'create_agent dropped: caller group not found',
    );
    return;
  }

  if (!isAdminCaller(senderUserId, task.isMain, callerAg.id)) {
    notifyAgent(callerAg.id, 'create_agent denied: sender is not an admin.');
    logger.warn(
      {
        senderUserId,
        callerAgentGroupId: callerAg.id,
        isMain: task.isMain,
      },
      'create_agent dropped: not admin',
    );
    return;
  }

  // --- Name validation ---
  const name = typeof task.name === 'string' ? task.name : '';
  if (!name || name.length > NAME_MAX) {
    notifyAgent(
      callerAg.id,
      `create_agent failed: invalid name (1-${NAME_MAX} chars).`,
    );
    logger.warn(
      { name, callerAgentGroupId: callerAg.id },
      'create_agent dropped: invalid name',
    );
    return;
  }

  // --- Folder selection ---
  // Explicit folder wins; otherwise slugify the name. Slugify can produce
  // an empty string for inputs that contain no [a-z0-9] chars — reject in
  // that case so the regex check below catches the same path consistently.
  const requested = task.folder ? task.folder.slice(0, FOLDER_MAX) : '';
  let base = requested || slugify(name);
  base = base.slice(0, FOLDER_MAX);
  if (!FOLDER_RE.test(base) || !isValidGroupFolder(base)) {
    notifyAgent(
      callerAg.id,
      `create_agent failed: folder must match ${FOLDER_RE.source} ` +
        `and not be a reserved name.`,
    );
    logger.warn(
      { folder: base, name, callerAgentGroupId: callerAg.id },
      'create_agent dropped: invalid folder',
    );
    return;
  }

  // Collision probe. base, base-2, base-3, ... up to FOLDER_SUFFIX_LIMIT.
  let final = base;
  let suffix = 2;
  while (getAgentGroupByFolder(final)) {
    final = `${base}-${suffix++}`;
    if (suffix > FOLDER_SUFFIX_LIMIT) {
      notifyAgent(
        callerAg.id,
        `create_agent failed: folder collision after ${FOLDER_SUFFIX_LIMIT} attempts.`,
      );
      logger.warn(
        { base, callerAgentGroupId: callerAg.id },
        'create_agent dropped: folder collision exhausted',
      );
      return;
    }
  }

  // --- DB row ---
  // Phase 5A wired agent_provider on agent_groups; resolveProviderName is
  // the single source of truth for provider resolution. New rows persist
  // the resolved name so subsequent spawns get a stable provider value
  // even if the global default shifts.
  const newAg = createAgentGroup({
    name,
    folder: final,
    agent_provider: resolveProviderName(null),
  });

  // --- Filesystem scaffold ---
  try {
    initGroupFilesystem(newAg, {
      instructions: task.instructions ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notifyAgent(callerAg.id, `create_agent failed: ${msg}`);
    logger.error(
      {
        err,
        newAgentGroupId: newAg.id,
        folder: final,
        callerAgentGroupId: callerAg.id,
      },
      'create_agent: initGroupFilesystem failed; agent_groups row left in place ' +
        'for operator cleanup (no v1 transactional rollback)',
    );
    return;
  }

  // --- Membership ---
  // Add the calling user as a member of the new group so they retain
  // access under `sender_scope='known'` wirings. Skip when senderUserId
  // is undefined (the isMain fallback path) — there's no user to attach.
  if (senderUserId) {
    addMember({
      user_id: senderUserId,
      agent_group_id: newAg.id,
      added_by: senderUserId,
    });
  }

  notifyAgent(
    callerAg.id,
    `Agent "${name}" created (folder=${final}). ` +
      `Run /wire <messaging-group> ${final} to attach it to a chat.`,
  );
  logger.info(
    {
      newAgentGroupId: newAg.id,
      folder: final,
      parentAgentGroupId: callerAg.id,
      groupsDir: GROUPS_DIR,
    },
    'agent group created via create_agent',
  );
}
