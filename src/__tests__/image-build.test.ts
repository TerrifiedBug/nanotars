/**
 * Phase 5B — generateAgentGroupDockerfile tests.
 *
 * Pure string-builder; we drive it with temp dirs to exercise both the
 * partials-inlining branch and the path-traversal / missing-file rejection
 * branches.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateAgentGroupDockerfile } from '../image-build.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanotars-5b-'));
});

describe('generateAgentGroupDockerfile', () => {
  it('emits FROM + USER root + USER node with no packages', () => {
    const out = generateAgentGroupDockerfile({
      baseImage: 'nanoclaw-agent:latest',
      apt: [], npm: [], partials: [], projectRoot: tmp,
    });
    expect(out).toContain('FROM nanoclaw-agent:latest');
    expect(out).toContain('USER root');
    expect(out).toContain('USER node');
    expect(out).not.toContain('apt-get');
    expect(out).not.toContain('npm install');
  });

  it('emits apt + npm RUN lines', () => {
    const out = generateAgentGroupDockerfile({
      baseImage: 'nanoclaw-agent:latest',
      apt: ['curl', 'jq'], npm: ['typescript'], partials: [], projectRoot: tmp,
    });
    expect(out).toMatch(/apt-get install -y curl jq/);
    expect(out).toMatch(/npm install -g typescript/);
  });

  it('inlines partial body with provenance comment', () => {
    const partialPath = path.join(tmp, 'plugins', 'foo', 'Dockerfile.partial');
    fs.mkdirSync(path.dirname(partialPath), { recursive: true });
    fs.writeFileSync(partialPath, 'RUN echo hi\n');
    const out = generateAgentGroupDockerfile({
      baseImage: 'nanoclaw-agent:latest',
      apt: [], npm: [], partials: ['plugins/foo/Dockerfile.partial'], projectRoot: tmp,
    });
    expect(out).toContain('# --- partial: plugins/foo/Dockerfile.partial ---');
    expect(out).toContain('RUN echo hi');
  });

  it('rejects path traversal partials', () => {
    expect(() =>
      generateAgentGroupDockerfile({
        baseImage: 'nanoclaw-agent:latest',
        apt: [], npm: [], partials: ['../etc/passwd'], projectRoot: tmp,
      })
    ).toThrow(/escapes project root/);
  });

  it('rejects missing partial files', () => {
    expect(() =>
      generateAgentGroupDockerfile({
        baseImage: 'nanoclaw-agent:latest',
        apt: [], npm: [], partials: ['plugins/foo/missing.partial'], projectRoot: tmp,
      })
    ).toThrow(/not found or not a file/);
  });
});
