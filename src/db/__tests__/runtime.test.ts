import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  finishRuntimeContainer,
  getRuntimeSummary,
  listRuntimeContainers,
  recordRuntimeContainerStart,
  touchRuntimeContainer,
} from '../index.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('runtime container snapshot rows', () => {
  it('records active and finished container runs', () => {
    const row = recordRuntimeContainerStart({
      container_name: 'nanoclaw-main-1',
      group_folder: 'main',
      group_name: 'Main',
      chat_jid: 'tg:main',
      reason: 'message',
      model: 'claude-sonnet-4-5',
      pid: 123,
      log_file: '/tmp/container.log',
      started_at: '2026-05-01T10:00:00.000Z',
    });

    expect(listRuntimeContainers({ activeOnly: true })).toMatchObject([
      {
        run_id: row.run_id,
        container_name: 'nanoclaw-main-1',
        group_folder: 'main',
        status: 'running',
        pid: 123,
      },
    ]);

    finishRuntimeContainer({
      run_id: row.run_id,
      status: 'completed',
      exit_code: 0,
      finished_at: '2026-05-01T10:01:00.000Z',
    });

    expect(listRuntimeContainers({ activeOnly: true })).toHaveLength(0);
    expect(listRuntimeContainers({ limit: 1 })[0]).toMatchObject({
      run_id: row.run_id,
      status: 'completed',
      exit_code: 0,
      finished_at: '2026-05-01T10:01:00.000Z',
    });
  });

  it('summarizes active containers and recent failures', () => {
    recordRuntimeContainerStart({
      container_name: 'nanoclaw-main-active',
      group_folder: 'main',
      reason: 'message',
      started_at: '2026-05-01T10:00:00.000Z',
    });
    const failed = recordRuntimeContainerStart({
      container_name: 'nanoclaw-work-failed',
      group_folder: 'work',
      reason: 'scheduled_task',
      started_at: '2026-05-01T10:00:00.000Z',
    });
    finishRuntimeContainer({
      run_id: failed.run_id,
      status: 'failed',
      exit_code: 1,
      error: 'boom',
      finished_at: '2026-05-01T10:03:00.000Z',
    });

    const summary = getRuntimeSummary(new Date('2026-05-01T10:30:00.000Z'));
    expect(summary.active).toBe(1);
    expect(summary.recent_failures).toBe(1);
    expect(summary.latest.map((row) => row.group_folder)).toContain('work');
  });

  it('touches heartbeat and updated timestamp for active runs', () => {
    const row = recordRuntimeContainerStart({
      container_name: 'nanoclaw-main-touch',
      group_folder: 'main',
      reason: 'message',
      started_at: '2026-05-01T10:00:00.000Z',
    });

    touchRuntimeContainer(row.run_id, '2026-05-01T10:00:05.000Z');

    expect(listRuntimeContainers({ limit: 1 })[0]).toMatchObject({
      run_id: row.run_id,
      heartbeat_at: '2026-05-01T10:00:05.000Z',
      updated_at: '2026-05-01T10:00:05.000Z',
    });
  });
});
