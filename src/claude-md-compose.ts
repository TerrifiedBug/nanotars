/**
 * CLAUDE.md composition for v1 registered groups.
 *
 * Regenerates groups/<folder>/CLAUDE.md at every spawn from:
 *   - shared base (container/CLAUDE.md mounted RO at /app/CLAUDE.md, symlinked)
 *   - per-plugin skill fragments (plugins shipping container-skills/<name>/instructions.md
 *     OR container-skills/<name>/SKILL.md as a fallback — allows gradual convention migration)
 *   - per-group writable memory (CLAUDE.local.md, agent-owned)
 *
 * Deterministic — same inputs produce the same CLAUDE.md. Stale fragments
 * are pruned. Host never overwrites CLAUDE.local.md.
 *
 * v1 adaptation: plugins live in gitignored plugins/<name>/ rather than
 * v2's container/skills/. Fragment content is inline-copied into the
 * fragments dir rather than symlinked, since v1 plugins don't share a
 * predictable container-side path.
 *
 * Adopted from upstream nanoclaw v2 src/claude-md-compose.ts.
 */
import fs from 'fs';
import path from 'path';

const SHARED_CLAUDE_MD_CONTAINER_PATH = '/app/CLAUDE.md';
const COMPOSED_HEADER =
  '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->';

export interface ComposeOptions {
  /** Override project root (defaults to process.cwd()) — for tests. */
  projectRoot?: string;
}

export interface ComposableGroup {
  folder: string;
}

/**
 * Regenerate `groups/<folder>/CLAUDE.md` from shared base + skill fragments.
 * Idempotent — safe to call on every spawn.
 *
 * Skill fragment discovery order (first match wins per skill name):
 *   1. `plugins/<plugin>/container-skills/<skill>/instructions.md`
 *   2. `plugins/<plugin>/container-skills/<skill>/SKILL.md` (fallback)
 * This allows a gradual convention migration from SKILL.md → instructions.md.
 */
export function composeGroupClaudeMd(group: ComposableGroup, options: ComposeOptions = {}): void {
  const projectRoot = options.projectRoot ?? process.cwd();
  const groupDir = path.resolve(projectRoot, 'groups', group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  // Shared base symlink — target is a container path; dangling on host, valid in container.
  const sharedLink = path.join(groupDir, '.claude-shared.md');
  syncSymlink(sharedLink, SHARED_CLAUDE_MD_CONTAINER_PATH);

  // Fragments dir
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (!fs.existsSync(fragmentsDir)) {
    fs.mkdirSync(fragmentsDir, { recursive: true });
  }

  // Discover per-plugin skill fragments by walking plugins/*/container-skills/*/
  const desired = new Map<string, string>(); // fragment-name → fragment-content
  const pluginsDir = path.join(projectRoot, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    for (const pluginName of fs.readdirSync(pluginsDir)) {
      const skillsDir = path.join(pluginsDir, pluginName, 'container-skills');
      if (!fs.existsSync(skillsDir)) continue;
      for (const skillDir of fs.readdirSync(skillsDir)) {
        const instructionsPath = path.join(skillsDir, skillDir, 'instructions.md');
        const skillMdPath = path.join(skillsDir, skillDir, 'SKILL.md');
        // Prefer instructions.md; fall back to SKILL.md for legacy plugins
        const fragmentSource = fs.existsSync(instructionsPath)
          ? instructionsPath
          : fs.existsSync(skillMdPath)
            ? skillMdPath
            : null;
        if (fragmentSource !== null) {
          const content = fs.readFileSync(fragmentSource, 'utf-8');
          desired.set(`skill-${skillDir}.md`, content);
        }
      }
    }
  }

  // Reconcile: drop stale fragments, write desired (inline copy for v1)
  for (const existing of fs.readdirSync(fragmentsDir)) {
    if (!desired.has(existing)) {
      fs.unlinkSync(path.join(fragmentsDir, existing));
    }
  }
  for (const [name, content] of desired) {
    writeAtomic(path.join(fragmentsDir, name), content);
  }

  // Composed entry — imports only
  const imports: string[] = ['@./.claude-shared.md'];
  for (const name of [...desired.keys()].sort()) {
    imports.push(`@./.claude-fragments/${name}`);
  }
  imports.push('@./CLAUDE.local.md');
  const body = [COMPOSED_HEADER, ...imports, ''].join('\n');
  writeAtomic(path.join(groupDir, 'CLAUDE.md'), body);

  // Per-group writable memory — never overwrite if exists
  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(localFile, '');
  }
}

function syncSymlink(linkPath: string, target: string): void {
  let currentTarget: string | null = null;
  try {
    currentTarget = fs.readlinkSync(linkPath);
  } catch {
    /* missing or not a symlink */
  }
  if (currentTarget === target) return;
  try {
    fs.unlinkSync(linkPath);
  } catch {
    /* missing */
  }
  fs.symlinkSync(target, linkPath);
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
