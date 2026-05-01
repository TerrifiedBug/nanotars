import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { auditEnvScope } from '../env-scope-audit.js';
import type { LoadedPlugin } from '../plugin-types.js';

function plugin(manifest: LoadedPlugin['manifest']): LoadedPlugin {
  return { manifest, dir: '', hooks: {} };
}

function write(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
}

describe('auditEnvScope', () => {
  let tmp: string;
  let log: { warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanotars-env-audit-'));
    log = { warn: vi.fn() };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('warns when a group-scoped plugin secret is only in root .env', () => {
    write(path.join(tmp, '.env'), 'GH_TOKEN=secret\n');
    fs.mkdirSync(path.join(tmp, 'groups', 'work'), { recursive: true });

    auditEnvScope({
      projectRoot: tmp,
      groupsDir: path.join(tmp, 'groups'),
      plugins: [
        plugin({
          name: 'github',
          containerEnvVars: ['GH_TOKEN'],
          groups: ['work'],
        }),
      ],
      log: log as any,
    });

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({
      key: 'GH_TOKEN',
      plugin: 'github',
      scopedGroups: ['work'],
      suggestedFile: 'groups/work/.env',
    });
  });

  it('does not warn when the group-scoped secret is also in that group env', () => {
    write(path.join(tmp, '.env'), 'GH_TOKEN=global\n');
    write(path.join(tmp, 'groups', 'work', '.env'), 'GH_TOKEN=group\n');

    auditEnvScope({
      projectRoot: tmp,
      groupsDir: path.join(tmp, 'groups'),
      plugins: [
        plugin({
          name: 'github',
          containerEnvVars: ['GH_TOKEN'],
          groups: ['work'],
        }),
      ],
      log: log as any,
    });

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns when a global plugin secret is only in a group env', () => {
    write(path.join(tmp, 'groups', 'main', '.env'), 'OPENAI_API_KEY=secret\n');

    auditEnvScope({
      projectRoot: tmp,
      groupsDir: path.join(tmp, 'groups'),
      plugins: [
        plugin({
          name: 'transcription',
          hostEnvVars: ['OPENAI_API_KEY'],
          groups: ['*'],
        }),
      ],
      log: log as any,
    });

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({
      key: 'OPENAI_API_KEY',
      group: 'main',
      plugins: ['transcription'],
      suggestedFile: '.env',
    });
  });

  it('does not warn for group-only env when the plugin is scoped to that group', () => {
    write(path.join(tmp, 'groups', 'main', '.env'), 'OPENAI_API_KEY=secret\n');

    auditEnvScope({
      projectRoot: tmp,
      groupsDir: path.join(tmp, 'groups'),
      plugins: [
        plugin({
          name: 'transcription',
          hostEnvVars: ['OPENAI_API_KEY'],
          groups: ['main'],
        }),
      ],
      log: log as any,
    });

    expect(log.warn).not.toHaveBeenCalled();
  });
});
