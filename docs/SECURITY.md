# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Channel messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (Docker on Linux, Apple Container on macOS), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

**Docker-specific hardening:**
- `--shm-size=2g` — Provides sufficient shared memory for Chromium without sharing host IPC namespace
- `--cap-add=SYS_PTRACE` — Required for Chromium's crashpad (scoped to container only)
- Custom seccomp profile (`chromium-seccomp.json`) — Allows Chromium sandboxing syscalls while blocking others
- `--init` — Reaps zombie processes within the container

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

**Input Validation:** Group folder names are validated on registration to reject path traversal characters (`/`, `\`, `..`). This prevents a compromised main-group agent from registering groups with folder names that escape the intended directory hierarchy.

### 5. Outbound Secret Redaction

All outbound messages and container log files are run through `redactSecrets()` (`src/secret-redact.ts`) before leaving the host process. This prevents accidental leakage of API keys via social engineering (e.g., agent tricked into running `env` or `echo $ANTHROPIC_API_KEY`).

**How it works:**
- At startup, `loadSecrets()` reads ALL key-value pairs from `.env`
- Values >= 8 characters are stored as secrets to redact (shorter values skipped to avoid false positives)
- A small safe-list of known non-secret config vars is exempted (`ASSISTANT_NAME`, `CLAUDE_MODEL`, `LOG_LEVEL`, etc.)
- Everything else is treated as potentially sensitive — new secrets are automatically protected
- `redactSecrets()` builds a pre-escaped composite regex at load time — special characters in API keys are properly escaped via `String.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`

**Where it's applied:**
- `routeOutbound()` in `src/router.ts` — catches ALL outbound message paths (orchestrator, IPC, scheduler)
- Container log writes in `src/container-runner.ts` — prevents secrets from persisting on disk

This is a programmatic safety net, not a policy-based one. Even if the agent is tricked into outputting a secret value, the redaction strips it before it reaches the channel.

### 6. Credential Handling

**Mounted Credentials:**
- Claude auth tokens (filtered from `.env`, read-only)

**NOT Mounted:**
- Channel session data (`store/auth/`) - host only
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns

**Credential Filtering:**
Only allowlisted environment variables are exposed to containers. The base set includes `ANTHROPIC_API_KEY`, `ASSISTANT_NAME`, and `CLAUDE_MODEL`. Plugins can declare additional variables via `containerEnvVars` in their `plugin.json` manifest — these are scoped per plugin and per group.

> **Note:** Anthropic credentials are mounted so that Claude Code can authenticate when the agent runs. However, this means the agent itself can discover these credentials via Bash or file operations. Ideally, Claude Code would authenticate without exposing credentials to the agent's execution environment, but I couldn't figure this out. **PRs welcome** if you have ideas for credential isolation.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Agent runner source | `/app/src` (ro) | `/app/src` (ro) |
| Environment vars | `/workspace/env-dir` (ro) | `/workspace/env-dir` (ro) |
| IPC directory | `/workspace/ipc` (rw) | `/workspace/ipc` (rw) |
| Plugin skills/hooks | `/workspace/skills`, `/workspace/hooks` (ro) | `/workspace/skills`, `/workspace/hooks` (ro) |
| MCP config | `/workspace/.mcp.json` (ro) | `/workspace/.mcp.json` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Channel Messages (potentially malicious)                          │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential filtering                                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • Network access (unrestricted)                                  │
│  • Cannot modify security config                                  │
└──────────────────────────────────────────────────────────────────┘
```
