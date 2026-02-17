# Security Model

## Overview

NanoClaw's security model is built on container isolation with explicit mount boundaries. Agents run in ephemeral Linux containers and can only access directories that are explicitly mounted. Multiple layers of defense prevent privilege escalation.

## Threat Model

**Trust boundary:** The container wall. Everything outside the container is trusted (host process). Everything inside the container is untrusted (AI agent could be manipulated).

**Key threats:**
1. Agent reads/modifies files outside its scope
2. Agent escalates from non-main to main privileges
3. Agent accesses credentials or secrets
4. Agent tampers with security configuration
5. Agent sends messages to unauthorized chats

## Container Isolation

### Mount Boundaries

```
┌─────────────────────────────────────────────┐
│                  HOST                         │
│                                               │
│  ~/.config/nanoclaw/mount-allowlist.json ←── Tamper-proof (not mounted)
│  .env, secrets ←─────────────────────────── Not mounted (stdin only)
│  src/, node_modules/ ←───────────────────── Not mounted
│                                               │
│  ┌──────────────────────────────────────┐    │
│  │           CONTAINER                    │    │
│  │                                        │    │
│  │  /workspace/group/ ←── Read-write      │    │
│  │  /workspace/ipc/ ←──── Read-write      │    │
│  │  /workspace/skills/ ←─ Read-only       │    │
│  │  /workspace/global/ ←─ Read-only*      │    │
│  │  /workspace/project/ ← Main only       │    │
│  │  /workspace/extra/ ←── Per-allowlist   │    │
│  │                                        │    │
│  └──────────────────────────────────────┘    │
└─────────────────────────────────────────────┘

* Read-write for main group, read-only for non-main
```

### Main vs Non-Main Privileges

| Capability | Main Group | Non-Main Group |
|------------|-----------|----------------|
| Project root access | Read-write | None |
| Global CLAUDE.md | Read-write | Read-only |
| Own group folder | Read-write | Read-write |
| IPC: send to any chat | Yes | Own chats only |
| IPC: manage any task | Yes | Own tasks only |
| IPC: register groups | Yes | No |
| IPC: refresh metadata | Yes | No |
| Additional mounts | Per-allowlist | Per-allowlist + forced read-only |

## Mount Allowlist

External configuration at `~/.config/nanoclaw/mount-allowlist.json`. Stored outside project root so containers cannot modify it.

### Format

```json
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    },
    {
      "path": "~/Documents/work",
      "allowReadWrite": false,
      "description": "Work documents (read-only)"
    }
  ],
  "blockedPatterns": [
    "password",
    "secret",
    "token"
  ],
  "nonMainReadOnly": true
}
```

### Validation Pipeline

1. **Path expansion:** Resolve `~` to home directory
2. **Symlink resolution:** `realpathSync()` resolves to canonical path (prevents symlink bypass)
3. **Blocked pattern check:** Rejects paths containing `.ssh`, `.aws`, `.env`, `credentials`, private keys, etc.
4. **Allowed root check:** Path must fall under a declared allowed root
5. **Container path validation:** No `..`, no absolute paths, non-empty
6. **Read-only enforcement:** Three-factor: mount request × root policy × `nonMainReadOnly`

### Default Blocked Patterns

```
.ssh, .gnupg, .gpg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, .pypirc,
id_rsa, id_ed25519, private_key, .secret
```

User-defined patterns in the allowlist are merged with defaults.

### Fail Secure

If the allowlist file is missing or invalid, ALL additional mounts are blocked. This prevents accidental exposure if the config is deleted.

## Credential Handling

### Secret Isolation

```
┌──────────────┐     stdin JSON     ┌──────────────┐
│   Host       │ ──────────────────▶│  Container   │
│              │  {secrets: {...}}   │              │
│  .env file   │                    │  SDK env     │──▶ Claude API
│  (not mounted)│                   │  (isolated)  │
│              │                    │              │
│              │                    │  process.env │──▶ Bash tools
│              │                    │  (NO secrets)│    (safe)
└──────────────┘                    └──────────────┘
```

1. Secrets read from `.env` on host
2. Passed via stdin JSON (not env vars, not mounts)
3. Inside container: merged into SDK `env` option only
4. Never written to `process.env` — Bash subprocesses can't access them

### Security Hooks (In-Container)

| Hook | Trigger | Action |
|------|---------|--------|
| `sanitizeBashHook` | PreToolUse:Bash | Blocks commands referencing `SECRET_ENV_VARS` |
| `secretPathBlockHook` | PreToolUse:Read | Blocks reads of `/proc/*/environ` and similar paths |

### OAuth Credential Sync

- Host copies `~/.claude/.credentials.json` to per-group session dir before spawn
- Container uses credentials for SDK auth
- If refreshed inside container, host detects newer `expiresAt` on exit
- Syncs refreshed credentials back to host

## IPC Authorization

Identity is determined by IPC directory location, not file contents. This prevents spoofing since containers can only write to their own mounted IPC directory.

```
Container for group "work-chat" can only write to:
  /workspace/ipc/messages/   → mapped to data/ipc/work-chat/messages/
  /workspace/ipc/tasks/      → mapped to data/ipc/work-chat/tasks/

IPC watcher reads from data/ipc/work-chat/ and knows
the source identity is "work-chat" (from directory path).
```

### Message Authorization

```
Main group → can send to any chatJid
Non-main "work-chat" → can only send to chats where
  registeredGroups[chatJid].folder === "work-chat"
```

Unauthorized attempts are blocked and logged as warnings.

### Task Authorization

```
Main group → can manage any task
Non-main "work-chat" → can only manage tasks where
  task.group_folder === "work-chat"
```

### Restricted Operations

These IPC commands are main-only:
- `register_group` — register new groups
- `refresh_groups` — trigger channel metadata sync

Path traversal validation on folder names prevents `../` attacks in group registration.

## Environment Variable Filtering

Container env files only include explicitly declared variables:

1. Core vars: `ANTHROPIC_API_KEY`, `ASSISTANT_NAME`, `CLAUDE_MODEL`
2. Plugin-declared vars: from `containerEnvVars` in plugin manifests
3. All values shell-quoted to prevent injection

Undeclared env vars are NOT passed to containers, even if present in `.env`.

## Container Runtime Security

### Docker

- Containers run as `node` user (UID 1000), not root
- `--rm` flag: containers self-remove on exit
- Custom seccomp profile only loosens restrictions needed for Chromium
- Named containers (`nanoclaw-{group}-{timestamp}`) for cleanup tracking
- Orphan cleanup on startup: removes leftover containers from crashes

### Apple Container (macOS)

- Native sandboxing with permission-based file access
- No special seccomp or capability configuration needed
- Permission handling is automatic (no chown needed)

## Snapshot Visibility

State snapshots enforce privilege separation:

| Data | Main Group | Non-Main Group |
|------|-----------|----------------|
| Scheduled tasks | All tasks | Own tasks only |
| Available groups | All groups | Empty array |

This prevents non-main agents from discovering or interfering with other groups.
