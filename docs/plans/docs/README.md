# NanoClaw Technical Documentation

Generated: 2026-02-17

## Documents

| Document | Description |
|----------|-------------|
| [Architecture](architecture.md) | System architecture, component relationships, data flow diagrams |
| [Source Modules](source-modules.md) | Per-module reference for all TypeScript source files |
| [Plugin System](plugin-system.md) | Plugin manifest format, hooks, channel plugins, skill plugins |
| [Container System](container-system.md) | Container lifecycle, mounts, agent runner, streaming protocol |
| [IPC Protocol](ipc-protocol.md) | File-based IPC format, authorization model, task commands |
| [Database](database.md) | Schema, migrations, public API, backup strategy |
| [Security Model](security-model.md) | Mount allowlist, container isolation, credential handling |
| [Configuration](configuration.md) | Environment variables, constants, paths |

## Quick Architecture

```
Channel Plugins ─→ SQLite ─→ Polling Loop ─→ Container (Claude) ─→ Response
  (WhatsApp,       (DB)      (Orchestrator)   (Isolated Agent)     (Router)
   Discord, ...)
```

**Host Process:** Single Node.js orchestrator managing state, database, and queue
**Container Process:** Ephemeral Claude Agent SDK instance with mounted workspace
**Security Boundary:** Containers can only access explicitly mounted directories
