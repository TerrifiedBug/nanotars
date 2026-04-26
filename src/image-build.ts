/**
 * Phase 5B — per-agent-group Dockerfile generation.
 *
 * `generateAgentGroupDockerfile` is a pure string-builder: caller writes the
 * output to disk and runs `docker build`. The IO side (writing the file,
 * spawning the build) lives next to the runtime spawn path in
 * `container-runner.ts` as `buildAgentGroupImage`.
 *
 * Layering choice: per-group images stack on `nanoclaw-agent:latest`, NOT on
 * `node:22-slim`. The base image already has plugin Dockerfile.partials
 * baked in by `container/build.sh`, so per-group apt/npm/partials sit on top
 * without losing plugin layers. Trade-off: a `./container/build.sh` rerun
 * after a plugin install means per-group images still reference the OLD
 * plugin layer until the agent self-mods again. Acceptable for v1's plugin
 * churn rate (see plan §5B / spec).
 *
 * Mirrors v2's generateAgentGroupDockerfile (v2 src/container-runner.ts:569-607)
 * with one divergence: v1 base is always nanoclaw-agent:latest (or
 * CONTAINER_IMAGE override), NOT node:22-slim.
 */
import fs from 'fs';
import path from 'path';

export function generateAgentGroupDockerfile(args: {
  baseImage: string;
  apt: string[];
  npm: string[];
  partials: string[];
  projectRoot: string;
}): string {
  const { baseImage, apt, npm, partials, projectRoot } = args;

  let out = `FROM ${baseImage}\nUSER root\n`;

  if (apt.length > 0) {
    out += `RUN apt-get update && apt-get install -y ${apt.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npm.length > 0) {
    out += `RUN npm install -g ${npm.join(' ')}\n`;
  }

  for (const partial of partials) {
    const resolved = path.resolve(projectRoot, partial);
    const rel = path.relative(projectRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`dockerfilePartial escapes project root: ${partial}`);
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`dockerfilePartial not found or not a file: ${partial}`);
    }
    const body = fs.readFileSync(resolved, 'utf8').trimEnd();
    out += `# --- partial: ${rel} ---\n${body}\n`;
  }

  out += 'USER node\n';
  return out;
}
