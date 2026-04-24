import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateAgentGroupDockerfile } from './container-runner.js';

describe('generateAgentGroupDockerfile', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-gen-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const call = (args: Partial<Parameters<typeof generateAgentGroupDockerfile>[0]> = {}) =>
    generateAgentGroupDockerfile({
      baseImage: 'nanoclaw-agent:latest',
      apt: [],
      npm: [],
      partials: [],
      projectRoot: root,
      ...args,
    });

  it('empty build: FROM + USER root + USER node only', () => {
    const out = call();
    expect(out).toBe('FROM nanoclaw-agent:latest\nUSER root\nUSER node\n');
  });

  it('apt-only emits apt-get install with cleanup', () => {
    const out = call({ apt: ['gh', 'python3'] });
    expect(out).toContain('apt-get update && apt-get install -y gh python3 && rm -rf /var/lib/apt/lists/*');
  });

  it('npm-only emits pnpm install with per-package allowlist', () => {
    const out = call({ npm: ['puppeteer'] });
    expect(out).toContain("only-built-dependencies[]=puppeteer' >> /root/.npmrc");
    expect(out).toContain('pnpm install -g puppeteer');
  });

  it('USER node is the last directive', () => {
    const out = call({ apt: ['gh'], npm: ['tsx'] });
    const lines = out.trim().split('\n');
    expect(lines.at(-1)).toBe('USER node');
  });

  it('partials are inlined between package installs and USER node', () => {
    fs.mkdirSync(path.join(root, 'groups/g/partials'), { recursive: true });
    const p1 = 'groups/g/partials/himalaya.Dockerfile';
    const p2 = 'groups/g/partials/gws.Dockerfile';
    fs.writeFileSync(path.join(root, p1), 'RUN echo install-himalaya\n');
    fs.writeFileSync(path.join(root, p2), 'RUN echo install-gws\n');

    const out = call({ apt: ['gh'], partials: [p1, p2] });

    // Order: apt install → partial 1 → partial 2 → USER node
    const aptIdx = out.indexOf('apt-get install');
    const h1Idx = out.indexOf('install-himalaya');
    const h2Idx = out.indexOf('install-gws');
    const userIdx = out.indexOf('USER node');

    expect(aptIdx).toBeGreaterThan(-1);
    expect(h1Idx).toBeGreaterThan(aptIdx);
    expect(h2Idx).toBeGreaterThan(h1Idx);
    expect(userIdx).toBeGreaterThan(h2Idx);
  });

  it('partials get a header comment for debuggability', () => {
    fs.writeFileSync(path.join(root, 'a.Dockerfile'), 'RUN echo hi\n');
    const out = call({ partials: ['a.Dockerfile'] });
    expect(out).toContain('# --- partial: a.Dockerfile ---');
  });

  it('trailing newlines in partials get normalised', () => {
    fs.writeFileSync(path.join(root, 'a.Dockerfile'), 'RUN echo hi\n\n\n\n');
    const out = call({ partials: ['a.Dockerfile'] });
    // Expect exactly one \n between the partial body and the next line
    expect(out).toContain('RUN echo hi\nUSER node\n');
  });

  it('partials-only (no apt, no npm) still produces a valid image', () => {
    fs.writeFileSync(path.join(root, 'a.Dockerfile'), 'RUN echo hi\n');
    const out = call({ partials: ['a.Dockerfile'] });
    expect(out).not.toContain('apt-get');
    expect(out).not.toContain('pnpm');
    expect(out).toContain('RUN echo hi');
    expect(out).toContain('USER node');
  });

  it('rejects path that escapes projectRoot (relative)', () => {
    expect(() => call({ partials: ['../escape.Dockerfile'] })).toThrow(/escapes project root/);
  });

  it('rejects absolute path outside projectRoot', () => {
    expect(() => call({ partials: ['/etc/passwd'] })).toThrow(/escapes project root/);
  });

  it('rejects missing file', () => {
    expect(() => call({ partials: ['does/not/exist.Dockerfile'] })).toThrow(/not found or not a file/);
  });

  it('rejects a directory path', () => {
    fs.mkdirSync(path.join(root, 'a-dir'));
    expect(() => call({ partials: ['a-dir'] })).toThrow(/not found or not a file/);
  });
});
