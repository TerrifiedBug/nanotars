import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from './permissions/user-roles.js';

/**
 * Metadata for a slash-command that requires admin privileges.
 *
 * The ADMIN_COMMANDS map in this file is the source of truth for the
 * admin-command universe. Per-command description and usage are declared
 * here to be consumed by /help rendering and channel-plugin autocomplete.
 */
export interface AdminCommandMeta {
  /** The slash-prefixed command name, e.g. '/grant'. */
  name: string;
  /** One-line description for /help and channel-plugin autocomplete. */
  description: string;
  /** Argument usage hint, e.g. '<user_id> <role>'. Empty string if no args. */
  usage: string;
}

/**
 * Slash-commands that require admin privileges.
 *
 * Phase 4B introduces this gate to replace v1's implicit "main group only"
 * convention. Commands sent from non-admin users are refused with a
 * clear "admin-only" message instead of silently working in the main group.
 *
 * Slice 5: converted from Set<string> to Map<name, AdminCommandMeta> so
 * per-command metadata (description, usage) is declared in a single source
 * of truth. Map.has(name) still works for the existing isAdminCommand gate.
 */
const ADMIN_COMMANDS = new Map<string, AdminCommandMeta>([
  ['/grant',          { name: '/grant',          description: 'Grant a role to a user.',                              usage: '<user_id> <role>' }],
  ['/revoke',         { name: '/revoke',         description: 'Revoke a role from a user.',                           usage: '<user_id> <role>' }],
  ['/list-users',     { name: '/list-users',     description: 'List all known users with their roles.',               usage: '' }],
  ['/list-roles',     { name: '/list-roles',     description: 'List role definitions and who holds each.',            usage: '' }],
  // Slice 8: list-groups shows registered (folder, channel, chat) wirings.
  ['/list-groups',    { name: '/list-groups',    description: 'List registered agent groups and their wired chats.',  usage: '' }],
  // Slice 8: register-group is the canonical pairing-code generator. Works
  // across any channel (Telegram / WhatsApp / Discord / Slack / webhook) —
  // pairing codes are channel-agnostic.
  ['/register-group', { name: '/register-group', description: 'Pair the next chat (any channel) to an agent group folder.', usage: '<folder>' }],
  ['/delete-group',   { name: '/delete-group',   description: 'Delete a registered group.',                           usage: '<folder>' }],
  ['/restart',        { name: '/restart',        description: 'Restart all agent containers.',                        usage: '' }],
  // Phase 5D: soft-pause / resume the host. Layered on top of the existing
  // GroupQueue.emergencyStop kill-now path — see src/lifecycle.ts and
  // src/lifecycle-handlers.ts.
  ['/pause',          { name: '/pause',          description: 'Soft-pause host inbound processing for an agent group.', usage: '[reason]' }],
  ['/resume',         { name: '/resume',         description: 'Resume host inbound processing for an agent group.',     usage: '[reason]' }],
  // Phase 5B: force-rebuild a per-agent-group image. Handler lives in
  // src/rebuild-image-admin-command.ts; pairs with buildAgentGroupImage in
  // src/container-runner.ts.
  ['/rebuild-image',  { name: '/rebuild-image',  description: 'Force-rebuild a per-agent-group container image.',     usage: '<agent_group_id>' }],
  // Slice 8: /health prints a quick at-a-glance status (DB rows, agent
  // groups, uptime). Mirrors the nanotars-health skill.
  ['/health',         { name: '/health',         description: 'Quick service health summary.',                        usage: '' }],
  // Legacy alias for /register-group main. Kept for backward compatibility
  // and discoverability — the bootstrap CLI `nanotars pair-main` still
  // covers the no-admin-chat-yet case.
  ['/pair-telegram',  { name: '/pair-telegram',  description: '(Legacy) Alias for /register-group main.',             usage: '' }],
  // Slice 5: /help renders the admin-command list. Handler in help-command.ts.
  ['/help',           { name: '/help',           description: 'List all admin commands with descriptions.',           usage: '' }],
]);

/**
 * Normalize a command token so the lookup matches whether the user typed
 * the canonical hyphenated form (e.g. `/list-users`) OR the underscored
 * form Telegram requires for setMyCommands (e.g. `/list_users` after a
 * dropdown tap). Also strips the optional `@<botname>` suffix Telegram
 * appends in group chats.
 *
 * Exported so dispatchAdminCommand can apply the same normalization to
 * `args.command` before passing to handlers — handlers compare against
 * the canonical hyphenated names in their hardcoded sets.
 */
export function normalizeCommand(token: string): string {
  // Strip @<botname> suffix (Telegram convention in group chats).
  const noBot = token.split('@')[0];
  // Convert underscores → hyphens so /list_users matches the canonical
  // /list-users key in ADMIN_COMMANDS. Underscores are never legal in
  // canonical command names, so this is a safe one-way fold.
  return noBot.replace(/_/g, '-');
}

export function getAdminCommandMeta(name: string): AdminCommandMeta | undefined {
  return ADMIN_COMMANDS.get(normalizeCommand(name));
}

export function listAdminCommands(): AdminCommandMeta[] {
  return [...ADMIN_COMMANDS.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function isAdminCommand(text: string): boolean {
  if (!text) return false;
  const first = text.trim().split(/\s+/)[0];
  return ADMIN_COMMANDS.has(normalizeCommand(first));
}

export interface CommandPermissionDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether a user can run an admin command for a given agent group.
 *
 * Decision order: owner → global admin → scoped admin → deny.
 * Returns { allowed: false, reason: 'unauthenticated' } when userId is undefined.
 */
export function checkCommandPermission(
  userId: string | undefined,
  command: string,
  agentGroupId: string,
): CommandPermissionDecision {
  if (!userId) return { allowed: false, reason: 'unauthenticated' };
  if (isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global-admin' };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'scoped-admin' };
  return { allowed: false, reason: 'admin-only' };
}
