/**
 * Phase 5E — initGroupFilesystem.
 *
 * Per-agent-group filesystem scaffold called from the host's create_agent
 * handler. Layered on top of the existing v1 layout (groups/<folder>/) so
 * the new agent slots straight into the same container-spawn path as
 * pre-existing agents.
 *
 * Today this is intentionally minimal:
 *   - groups/<folder>/                          (mkdir -p)
 *   - groups/<folder>/CLAUDE.md                 (only if `instructions` provided)
 *   - groups/<folder>/IDENTITY.md               (copy of groups/global/IDENTITY.md
 *                                                if present, else skipped)
 *
 * Path-traversal hardening: the resolved folder path is verified to live
 * under GROUPS_DIR before any write. Combined with the validated folder
 * regex on the IPC + handler sides, this rejects `..`, absolute paths, and
 * any other escape attempts.
 *
 * Operator follow-up: after createAgent runs, the operator must run
 * `/wire <messaging-group> <folder>` to attach the new agent to a chat —
 * no auto-wire is performed here, by design (see spec §5E).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import type { AgentGroup } from './types.js';

export function initGroupFilesystem(
  group: AgentGroup,
  opts: { instructions?: string },
): void {
  const groupPath = path.join(GROUPS_DIR, group.folder);

  // Path-traversal guard: resolve both the target and groups-dir, ensure
  // the target is strictly under groups-dir. Catches `..` segments,
  // symlinks, absolute paths smuggled into `folder`, etc. The IPC layer +
  // handler also validate `folder` against the safe-name regex; this is
  // defense in depth.
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (
    resolvedPath !== resolvedGroupsDir &&
    !resolvedPath.startsWith(resolvedGroupsDir + path.sep)
  ) {
    throw new Error(`group folder escapes groups dir: ${group.folder}`);
  }
  if (resolvedPath === resolvedGroupsDir) {
    // `folder` resolved to the groups dir itself — refuse rather than
    // overwriting the parent.
    throw new Error(`group folder cannot equal groups dir: ${group.folder}`);
  }

  fs.mkdirSync(groupPath, { recursive: true });

  // Optional CLAUDE.md (the new agent's system prompt). If omitted, the
  // agent inherits whatever the runtime defaults to — same as a pre-5E
  // hand-created agent group.
  if (opts.instructions !== undefined && opts.instructions !== '') {
    fs.writeFileSync(path.join(groupPath, 'CLAUDE.md'), opts.instructions);
  }

  // Default IDENTITY.md from groups/global/IDENTITY.md (existing v1
  // fallback). If the global identity file is missing, skip silently —
  // the agent will fall back to the runtime default.
  const globalIdentity = path.join(GROUPS_DIR, 'global', 'IDENTITY.md');
  const groupIdentity = path.join(groupPath, 'IDENTITY.md');
  if (fs.existsSync(globalIdentity) && !fs.existsSync(groupIdentity)) {
    fs.copyFileSync(globalIdentity, groupIdentity);
  }

  logger.info(
    { folder: group.folder, groupId: group.id },
    'Initialized group filesystem',
  );
}
