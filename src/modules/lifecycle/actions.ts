/**
 * System action handlers for `emergency_stop` and `resume_processing`.
 *
 * Emitted by an agent via the normal system-action path (write to
 * outbound.db with kind='system'). Delivery picks it up and dispatches
 * here.
 *
 * Trust model: any agent can fire these. For a single-operator install
 * this is fine — there's only one principal on the box. In a multi-
 * user deployment you'd want a role check (owner/global-admin via
 * user_roles); out of scope for this first cut.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { pause, resume } from './index.js';

export async function handleEmergencyStop(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const reason = typeof content.reason === 'string' ? content.reason : 'requested by agent';
  log.warn('emergency_stop requested', { sessionId: session.id, agentGroupId: session.agent_group_id, reason });
  const killed = await pause(reason);
  log.info('emergency_stop complete', { killedCount: killed.length });
}

export async function handleResumeProcessing(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const reason = typeof content.reason === 'string' ? content.reason : 'requested by agent';
  log.info('resume_processing requested', { sessionId: session.id, agentGroupId: session.agent_group_id, reason });
  resume(reason);
}
