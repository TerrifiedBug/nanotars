import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config.js';
import { createTask, deleteTask, getTaskById, isValidGroupFolder, updateTask } from '../db.js';
import { hasTable, getDb } from '../db/init.js';
import { logger } from '../logger.js';
import {
  createPendingQuestion,
  type NormalizedOption,
} from '../permissions/pending-questions.js';
import { ContainerConfig, EngageMode, SenderScope, IgnoredMessagePolicy } from '../types.js';
import { authorizedTaskAction } from './auth.js';
import { IpcDeps } from './types.js';

/**
 * Phase 4D D4: normalise an `ask_question` options array. Accepts plain
 * strings (used as both label and value) or `{label, selectedLabel?, value?}`
 * objects. Mirrors v2 `container/agent-runner/src/mcp-tools/interactive.ts`'s
 * shape so the post-D6 card-render path can pull title + options straight
 * from the pending_questions row without re-normalising.
 */
function normaliseOptions(raw: unknown): NormalizedOption[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedOption[] = [];
  for (const o of raw) {
    if (typeof o === 'string') {
      out.push({ label: o, selectedLabel: o, value: o });
      continue;
    }
    if (o && typeof o === 'object') {
      const obj = o as Record<string, unknown>;
      const label = typeof obj.label === 'string' ? obj.label : null;
      if (!label) continue;
      const selectedLabel = typeof obj.selectedLabel === 'string' ? obj.selectedLabel : label;
      const value = typeof obj.value === 'string' ? obj.value : label;
      out.push({ label, selectedLabel, value });
    }
  }
  return out;
}

/**
 * Phase 4D D6: render an ask_question card as plain text. Used until
 * per-adapter button rendering is wired (Telegram inline keyboard, Slack
 * blocks, …). The numbered-list shape matches what `deliverApprovalCard`
 * uses for approval cards so the user-facing UX is consistent.
 */
function formatAskQuestionAsText(args: {
  question_id: string;
  title: string;
  question: string;
  options: NormalizedOption[];
}): string {
  const lines: string[] = [];
  if (args.title) lines.push(args.title);
  if (args.title && args.question) lines.push('');
  if (args.question) lines.push(args.question);
  if (args.options.length > 0) {
    lines.push('');
    for (const o of args.options) {
      lines.push(`- Reply "${o.value}" to ${o.label}`);
    }
  }
  lines.push('', `(question: ${args.question_id})`);
  return lines.join('\n');
}

/** Compute the next run time for a schedule. Returns null nextRun on parse error. */
function computeNextRun(
  type: string,
  value: string,
): { nextRun: string | null; valid: boolean } {
  if (type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(value, { tz: TIMEZONE });
      return { nextRun: interval.next().toISOString(), valid: true };
    } catch {
      logger.warn({ scheduleValue: value }, 'Invalid cron expression');
      return { nextRun: null, valid: false };
    }
  } else if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (isNaN(ms) || ms <= 0) {
      logger.warn({ scheduleValue: value }, 'Invalid interval');
      return { nextRun: null, valid: false };
    }
    return { nextRun: new Date(Date.now() + ms).toISOString(), valid: true };
  } else if (type === 'once') {
    // Treat bare datetime strings (no Z or ±HH:MM) as UTC to avoid
    // silent local-timezone interpretation on the server.
    const hasTimezone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value);
    const scheduled = new Date(hasTimezone ? value : value + 'Z');
    if (isNaN(scheduled.getTime())) {
      logger.warn({ scheduleValue: value }, 'Invalid timestamp');
      return { nextRun: null, valid: false };
    }
    return { nextRun: scheduled.toISOString(), valid: true };
  }
  return { nextRun: null, valid: true };
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    model?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    pattern?: string;
    // Optional channel hint — see A3-review M3. orchestrator.registerGroup
    // throws if the channel can't be resolved (no adapter ownsJid match and
    // no channel field), so IPC clients on multi-channel installs should
    // pass this explicitly to avoid relying on adapter ownsJid heuristics.
    channel?: string;
    engage_mode?: EngageMode;
    sender_scope?: SenderScope;
    ignored_message_policy?: IgnoredMessagePolicy;
    containerConfig?: ContainerConfig;
    // Phase 4D D4: ask_question payload fields. Container fills these in
    // when the agent calls the `ask_question` MCP tool.
    questionId?: string;
    title?: string;
    question?: string;
    options?: unknown;
    timeout?: number;
    platform_id?: string | null;
    channel_type?: string | null;
    thread_id?: string | null;
    message_out_id?: string;
    // Phase 5D: emergency_stop / resume_processing optional reason
    reason?: string;
    // Phase 5E: create_agent optional instructions (CLAUDE.md content for
    // the new agent). `name` and `folder` reuse the existing fields above.
    instructions?: string | null;
    // Phase 5C: install_packages payload fields. Validated in the handler.
    apt?: unknown;
    npm?: unknown;
    // Phase 5C: add_mcp_server payload fields. `name` reused from above.
    command?: unknown;
    args?: unknown;
    env?: unknown;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const validScheduleTypes = new Set(['cron', 'interval', 'once']);
        if (!validScheduleTypes.has(data.schedule_type!)) {
          logger.warn({ scheduleType: data.schedule_type }, 'Invalid schedule_type in task IPC');
          break;
        }
        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        const { nextRun, valid } = computeNextRun(scheduleType, data.schedule_value);
        if (!valid) break;

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          model: data.model || null,
          script: data.script || null,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      authorizedTaskAction(data.taskId, sourceGroup, isMain, 'paused',
        (id) => updateTask(id, { status: 'paused' }));
      break;

    case 'resume_task':
      authorizedTaskAction(data.taskId, sourceGroup, isMain, 'resumed',
        (id) => updateTask(id, { status: 'active' }));
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          const updates: { prompt?: string; schedule_type?: 'cron' | 'interval' | 'once'; schedule_value?: string; next_run?: string | null; model?: string | null; script?: string | null } = {};
          const trimmedPrompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
          if (trimmedPrompt) updates.prompt = trimmedPrompt;
          if (data.model) updates.model = data.model as string;
          if (typeof data.script === 'string') updates.script = data.script;

          // If schedule changed, recompute next_run
          if (data.schedule_type && data.schedule_value) {
            const validScheduleTypes = new Set(['cron', 'interval', 'once']);
            if (!validScheduleTypes.has(data.schedule_type)) {
              logger.warn({ scheduleType: data.schedule_type }, 'Invalid schedule_type in update_task IPC');
              break;
            }
            updates.schedule_type = data.schedule_type as 'cron' | 'interval' | 'once';
            updates.schedule_value = data.schedule_value as string;
            const { nextRun, valid } = computeNextRun(data.schedule_type, data.schedule_value);
            if (!valid) break;
            updates.next_run = nextRun;
          }

          updateTask(data.taskId, updates);
          logger.info(
            { taskId: data.taskId, sourceGroup, updates: Object.keys(updates) },
            'Task updated via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized or unknown task update attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      authorizedTaskAction(data.taskId, sourceGroup, isMain, 'cancelled',
        (id) => deleteTask(id));
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.pattern) {
        // Validate folder name: allowlist of safe characters only
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { folder: data.folder },
            'Rejected register_group with invalid folder name (path traversal attempt)',
          );
          break;
        }
        // IPC-boundary validation: reject unknown enum values
        const validEngageModes = new Set<string>(['pattern', 'always', 'mention-sticky']);
        const validSenderScopes = new Set<string>(['all', 'known']);
        const validIgnoredMessagePolicies = new Set<string>(['drop', 'observe']);
        if (data.engage_mode !== undefined && !validEngageModes.has(data.engage_mode)) {
          logger.warn(
            { engage_mode: data.engage_mode },
            'Invalid engage_mode value in register_group IPC — quarantined',
          );
          break;
        }
        if (data.sender_scope !== undefined && !validSenderScopes.has(data.sender_scope)) {
          logger.warn(
            { sender_scope: data.sender_scope },
            'Invalid sender_scope value in register_group IPC — quarantined',
          );
          break;
        }
        if (data.ignored_message_policy !== undefined && !validIgnoredMessagePolicies.has(data.ignored_message_policy)) {
          logger.warn(
            { ignored_message_policy: data.ignored_message_policy },
            'Invalid ignored_message_policy value in register_group IPC — quarantined',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          pattern: data.pattern,
          added_at: new Date().toISOString(),
          channel: data.channel,
          containerConfig: data.containerConfig,
          engage_mode: data.engage_mode ?? 'pattern',
          sender_scope: data.sender_scope ?? 'all',
          ignored_message_policy: data.ignored_message_policy ?? 'drop',
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'emergency_stop': {
      // Phase 5D: soft-pause layer — pausedGate.pause() blocks future container
      // wakes while in-flight containers complete their current turn. The
      // existing kill-now path (deps.emergencyStop) is intentionally NOT
      // called from here; it remains available for graceful shutdown and
      // future admin paths. See spec §5D and src/lifecycle-handlers.ts.
      const { handleEmergencyStop } = await import('../lifecycle-handlers.js');
      await handleEmergencyStop(
        {
          reason: typeof data.reason === 'string' ? data.reason : undefined,
          groupFolder: sourceGroup,
          isMain,
        },
        // Sender threading is incomplete in v1-archive (see lifecycle-handlers
        // file header). Until it lands, the handler falls back to isMain.
        undefined,
      );
      break;
    }

    case 'resume_processing': {
      const { handleResumeProcessing } = await import('../lifecycle-handlers.js');
      await handleResumeProcessing(
        {
          reason: typeof data.reason === 'string' ? data.reason : undefined,
          groupFolder: sourceGroup,
          isMain,
        },
        undefined,
      );
      break;
    }

    case 'install_packages': {
      // Phase 5C: agent-initiated package install request. Host validates,
      // queues an admin approval card via the 4C primitive, and (on approve)
      // mutates container_config + rebuilds the per-group image (5B) +
      // restarts the container (5C-04).
      //
      // No senderUserId threading on this path (same gap as
      // lifecycle-handlers.ts / create-agent.ts). The approval click-router
      // (Phase 4D D7) is the gate that enforces admin policy.
      const { handleInstallPackagesRequest } = await import(
        '../permissions/install-packages.js'
      );
      const apt = Array.isArray((data as { apt?: unknown }).apt)
        ? ((data as { apt: unknown[] }).apt.filter(
            (x) => typeof x === 'string',
          ) as string[])
        : [];
      const npm = Array.isArray((data as { npm?: unknown }).npm)
        ? ((data as { npm: unknown[] }).npm.filter(
            (x) => typeof x === 'string',
          ) as string[])
        : [];
      const reason =
        typeof (data as { reason?: unknown }).reason === 'string'
          ? ((data as { reason: string }).reason)
          : '';
      await handleInstallPackagesRequest(
        {
          apt,
          npm,
          reason,
          groupFolder: sourceGroup,
        },
        '',
      );
      break;
    }

    case 'add_mcp_server': {
      // Phase 5C: agent-initiated MCP-server wire request. Same shape as
      // install_packages but no image rebuild — agent-runner reads
      // mcpServers from container_config at spawn time.
      const { handleAddMcpServerRequest } = await import(
        '../permissions/add-mcp-server.js'
      );
      const args = Array.isArray((data as { args?: unknown }).args)
        ? ((data as { args: unknown[] }).args.filter(
            (x) => typeof x === 'string',
          ) as string[])
        : [];
      const env =
        typeof (data as { env?: unknown }).env === 'object' &&
        (data as { env?: unknown }).env !== null &&
        !Array.isArray((data as { env?: unknown }).env)
          ? Object.fromEntries(
              Object.entries((data as { env: Record<string, unknown> }).env)
                .filter(([, v]) => typeof v === 'string')
                .map(([k, v]) => [k, v as string]),
            )
          : {};
      await handleAddMcpServerRequest(
        {
          name: typeof data.name === 'string' ? data.name : '',
          command:
            typeof (data as { command?: unknown }).command === 'string'
              ? ((data as { command: string }).command)
              : '',
          args,
          env,
          groupFolder: sourceGroup,
        },
        '',
      );
      break;
    }

    case 'create_skill_plugin': {
      // Slice 6: chat-driven plugin creation. Host validates the spec
      // (defense in depth), queues an admin approval card via the 4C
      // primitive, and on approve writes plugin files + restarts the
      // originating group's container.
      const { handleCreateSkillPluginRequest } = await import(
        '../permissions/create-skill-plugin.js'
      );
      const name = typeof data.name === 'string' ? data.name : '';
      const description =
        typeof (data as unknown as { description?: unknown }).description === 'string'
          ? ((data as unknown as { description: string }).description)
          : '';
      const archetype =
        (data as unknown as { archetype?: unknown }).archetype === 'mcp' ? 'mcp' : 'skill-only';
      const pluginJson =
        typeof (data as unknown as { pluginJson?: unknown }).pluginJson === 'object' &&
        (data as unknown as { pluginJson?: unknown }).pluginJson !== null
          ? ((data as unknown as { pluginJson: Record<string, unknown> }).pluginJson)
          : ({} as Record<string, unknown>);
      const containerSkillMd =
        typeof (data as unknown as { containerSkillMd?: unknown }).containerSkillMd === 'string'
          ? ((data as unknown as { containerSkillMd: string }).containerSkillMd)
          : '';
      const mcpJson =
        typeof (data as unknown as { mcpJson?: unknown }).mcpJson === 'string'
          ? ((data as unknown as { mcpJson: string }).mcpJson)
          : undefined;
      const envVarValues =
        typeof (data as unknown as { envVarValues?: unknown }).envVarValues === 'object' &&
        (data as unknown as { envVarValues?: unknown }).envVarValues !== null &&
        !Array.isArray((data as unknown as { envVarValues?: unknown }).envVarValues)
          ? Object.fromEntries(
              Object.entries(
                (data as unknown as { envVarValues: Record<string, unknown> }).envVarValues,
              )
                .filter(([, v]) => typeof v === 'string')
                .map(([k, v]) => [k, v as string]),
            )
          : undefined;
      // pluginJson coerced into the typed shape expected by the handler;
      // missing fields fall back to defaults at validation time.
      await handleCreateSkillPluginRequest(
        {
          name,
          description,
          archetype: archetype as 'skill-only' | 'mcp',
          pluginJson: pluginJson as never,
          containerSkillMd,
          mcpJson,
          envVarValues,
          groupFolder: sourceGroup,
        },
        '',
      );
      break;
    }

    case 'create_agent': {
      // Phase 5E: admin-only agent provisioning. The container-side MCP tool
      // is registered only when NANOCLAW_IS_ADMIN=1; the host re-validates
      // here as defense in depth. Sender threading on this IPC path is
      // incomplete in v1-archive (same gap as lifecycle-handlers.ts), so the
      // handler falls back to the isMain heuristic when senderUserId is
      // undefined.
      const { handleCreateAgent } = await import(
        '../permissions/create-agent.js'
      );
      await handleCreateAgent(
        {
          name: typeof data.name === 'string' ? data.name : '',
          instructions:
            typeof (data as { instructions?: unknown }).instructions === 'string'
              ? ((data as { instructions: string }).instructions)
              : null,
          folder: typeof data.folder === 'string' ? data.folder : null,
          groupFolder: sourceGroup,
          isMain,
        },
        undefined,
      );
      break;
    }

    case 'ask_question': {
      // Phase 4D D4: persist a pending_questions row for the agent's
      // ask_user_question call. The actual outbound card delivery and the
      // answer round-trip wiring (writing question_response back to the
      // agent's inbox) are deferred to D6 — this handler just records the
      // open question so D6 can find it, and so the `pending_questions`
      // PRIMARY KEY drops retries with the same question_id silently.
      //
      // Authorization: every group can ask its own agent a question. There's
      // no isMain gate because non-main groups have a legitimate need (e.g.
      // a child agent asking the user for confirmation in their own chat).
      if (!hasTable(getDb(), 'pending_questions')) {
        logger.warn(
          { sourceGroup },
          'ask_question received but pending_questions table missing — schema_version < 18?',
        );
        break;
      }
      if (!data.questionId || !data.question) {
        logger.warn(
          { sourceGroup, hasQuestionId: !!data.questionId, hasQuestion: !!data.question },
          'ask_question rejected: missing questionId or question text',
        );
        break;
      }
      const options = normaliseOptions(data.options);
      const inserted = createPendingQuestion({
        question_id: data.questionId,
        // v1-archive's session is the per-group container, so session_id
        // == sourceGroup (group_folder). D6 will use this to look up the
        // agent inbox when routing the response back.
        session_id: sourceGroup,
        message_out_id: data.message_out_id ?? data.questionId,
        platform_id: data.platform_id ?? null,
        channel_type: data.channel_type ?? null,
        thread_id: data.thread_id ?? null,
        title: typeof data.title === 'string' ? data.title : '',
        options,
        approval_id: null,
        created_at: new Date().toISOString(),
      });
      if (inserted) {
        // Phase 4D D6: deliver the question to the chat that originated
        // the agent session. Uses the IPC's existing sendMessage path so
        // the message goes out through the channel adapter the
        // orchestrator picks for the JID. Best-effort — failure is
        // logged + the row stays in pending_questions for diagnostic
        // visibility. Adapter-side button rendering (Telegram inline
        // keyboard, Slack blocks) is per-adapter follow-on work; the
        // plain-text fallback here renders the question + numbered
        // options as a single message that the user can reply to.
        if (data.platform_id) {
          const text = formatAskQuestionAsText({
            question_id: data.questionId,
            title: typeof data.title === 'string' ? data.title : '',
            question: typeof data.question === 'string' ? data.question : '',
            options,
          });
          // sendMessage might be a non-async stub in tests; wrap in
          // Promise.resolve so .catch always exists.
          Promise.resolve(deps.sendMessage(data.platform_id, text)).catch((err) =>
            logger.warn(
              { err, sourceGroup, questionId: data.questionId },
              'ask_question card delivery failed',
            ),
          );
        }
        logger.info(
          {
            sourceGroup,
            questionId: data.questionId,
            optionCount: options.length,
          },
          'ask_question received — pending_questions row persisted + delivery dispatched',
        );
      } else {
        // Same question_id arrived twice (agent retry, IPC replay, etc.).
        // PK conflict means the first row is still in flight; log + drop.
        logger.info(
          { sourceGroup, questionId: data.questionId },
          'ask_question duplicate dropped (question_id already pending)',
        );
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
