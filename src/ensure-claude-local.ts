import fs from 'fs';
import path from 'path';

/**
 * Ensure groups/<folder>/CLAUDE.local.md exists. Auto-loaded by Claude Code
 * via the CLAUDE.local.md convention; the agent uses it as per-group writable
 * memory. Host never edits this file.
 *
 * Phase 1 of the CLAUDE.md compose pipeline. The full host-regenerator
 * lands in Task B2.
 *
 * Adopted from upstream nanoclaw v2 src/claude-md-compose.ts (the
 * CLAUDE.local.md ensure-exists portion).
 */
export function ensureClaudeLocal(groupsDir: string, folder: string): void {
  const groupDir = path.join(groupsDir, folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }
  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(localFile, '');
  }
}
