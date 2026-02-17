# System Architecture

## Overview

NanoClaw is a personal Claude AI assistant that routes messages from communication channels to isolated Claude Agent SDK instances running in Docker or Apple Container. Single Node.js host process, ~6,300 lines of TypeScript.

### Core Principles

1. **Small enough to understand** — One process, handful of source files
2. **Secure by isolation** — Agents run in containers with explicit mount boundaries
3. **Built for one user** — Working software you fork and customize
4. **AI-native** — Claude Code guides setup, debugging, and customization
5. **Skills over features** — Contributors add transformation skills, not configuration

## High-Level Architecture

```mermaid
graph TB
    subgraph "Messaging Platforms"
        WA[WhatsApp<br/>Baileys]
        TG[Telegram<br/>Grammy]
        DC[Discord<br/>discord.js]
    end

    subgraph "Host Process (Node.js)"
        PL[Plugin Loader<br/>plugin-loader.ts]
        DB[(SQLite<br/>db.ts)]
        ML[Message Loop<br/>index.ts<br/>poll every 2s]
        GQ[Group Queue<br/>group-queue.ts]
        IPC[IPC Watcher<br/>ipc.ts<br/>poll every 1s]
        TS[Task Scheduler<br/>task-scheduler.ts<br/>poll every 60s]
        CR[Container Runner<br/>container-runner.ts]
        RT[Router<br/>router.ts]
    end

    subgraph "Container Boundary"
        AR[Agent Runner<br/>Claude Agent SDK]
        SK[Skills<br/>CLAUDE.md files]
        HK[Plugin Hooks<br/>Security, Archival]
    end

    WA --> PL
    TG --> PL
    DC --> PL
    PL --> DB
    DB --> ML
    ML --> GQ
    TS --> GQ
    GQ --> CR
    CR --> AR
    AR --> SK
    AR --> HK
    AR -->|stdout streaming| CR
    AR -->|IPC files| IPC
    IPC --> RT
    RT --> WA & TG & DC
```

## Component Relationships

```mermaid
graph LR
    subgraph "Startup Sequence"
        direction TB
        S1[initDatabase] --> S2[loadPlugins]
        S2 --> S3[connectChannels]
        S3 --> S4[startMessageLoop]
        S4 --> S5[startIpcWatcher]
        S5 --> S6[startTaskScheduler]
    end
```

### Module Dependency Graph

```mermaid
graph TD
    index[index.ts] --> db[db.ts]
    index --> pluginLoader[plugin-loader.ts]
    index --> groupQueue[group-queue.ts]
    index --> containerRunner[container-runner.ts]
    index --> ipc[ipc.ts]
    index --> taskScheduler[task-scheduler.ts]
    index --> router[router.ts]
    index --> snapshots[snapshots.ts]

    containerRunner --> containerMounts[container-mounts.ts]
    containerRunner --> containerRuntime[container-runtime.ts]
    containerMounts --> mountSecurity[mount-security.ts]
    containerMounts --> pluginLoader

    ipc --> db
    taskScheduler --> db
    taskScheduler --> groupQueue

    config[config.ts] --> index & db & ipc & containerRunner & containerMounts & mountSecurity
    types[types.ts] --> db & ipc & containerMounts & mountSecurity
```

## Data Flow

### Inbound Message Flow

```mermaid
sequenceDiagram
    participant C as Channel Plugin
    participant DB as SQLite
    participant ML as Message Loop
    participant GQ as GroupQueue
    participant CR as Container Runner
    participant AR as Agent Runner

    C->>DB: storeMessage(jid, msg)
    C->>DB: storeChatMetadata(jid, ts)
    ML->>DB: getNewMessages(jid, since)
    ML->>ML: Check trigger pattern
    ML->>GQ: enqueueMessageCheck(jid)
    GQ->>CR: runContainerAgent(group, prompt)
    CR->>AR: stdin: ContainerInput JSON
    AR->>AR: Claude Agent SDK query()
    AR-->>CR: stdout: OUTPUT_START_MARKER...OUTPUT_END_MARKER
    CR->>ML: Streaming result callback
```

### Multi-Turn Conversation Flow

```mermaid
sequenceDiagram
    participant U as User
    participant C as Channel
    participant GQ as GroupQueue
    participant AR as Agent Runner

    U->>C: Message 1
    C->>GQ: enqueueMessageCheck(jid)
    GQ->>AR: Spawn container, stdin prompt
    AR-->>C: Streaming response 1
    U->>C: Message 2 (while container alive)
    C->>GQ: enqueueMessageCheck(jid)
    GQ->>GQ: Container active → pipe via IPC
    GQ->>AR: Write IPC file to input/
    AR->>AR: IPC poller reads file
    AR->>AR: Resume SDK query from lastAssistantUuid
    AR-->>C: Streaming response 2
    Note over GQ,AR: Idle timeout → close sentinel → container exits
```

### Outbound Message Flow (IPC)

```mermaid
sequenceDiagram
    participant AR as Agent Runner
    participant FS as Filesystem
    participant IPC as IPC Watcher
    participant RT as Router
    participant CH as Channel

    AR->>FS: Write JSON to /workspace/ipc/messages/
    Note over FS: {type: "message", chatJid, text, sender?}
    IPC->>FS: Poll data/ipc/{group}/messages/
    IPC->>IPC: Authorization check
    IPC->>RT: routeOutbound(chatJid, text)
    RT->>CH: channel.sendMessage(jid, text, sender)
    RT->>FS: Delete processed IPC file
```

## Polling Architecture

Three independent polling loops run concurrently:

| Loop | Interval | Purpose | Source |
|------|----------|---------|--------|
| Message Loop | 2s | Fetch new messages from DB, trigger agent | `src/index.ts` |
| IPC Watcher | 1s | Process outbound messages and task commands | `src/ipc.ts` |
| Task Scheduler | 60s | Find due scheduled tasks, enqueue execution | `src/task-scheduler.ts` |

## Concurrency Model

```
                    ┌─────────────────────┐
                    │  MAX_CONCURRENT = 5  │
                    └─────────┬───────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   ┌────┴─────┐         ┌────┴─────┐         ┌────┴─────┐
   │ Group A   │         │ Group B   │         │ Group C   │
   │ 1 container│        │ 1 container│        │ Waiting... │
   │ at a time  │        │ at a time  │        │ (queued)   │
   └───────────┘         └───────────┘         └───────────┘
```

- Global limit: `MAX_CONCURRENT_CONTAINERS` (default 5)
- Per-group: exactly 1 container at a time (serialized)
- Follow-up messages pipe to active container via IPC (no new spawn)
- Tasks prioritized over messages in drain order
- Exponential backoff on failure: 5s, 10s, 20s, 40s, 80s (5 retries max)

## Filesystem Layout

```
nanoclaw/
├── src/                    # TypeScript source (compiled to dist/)
├── container/
│   ├── Dockerfile          # Agent container image
│   ├── build.sh            # Build script (merges Dockerfile.partial)
│   ├── agent-runner/src/   # In-container agent runner
│   └── skills/             # Core skills mounted into containers
├── plugins/
│   ├── channels/           # Channel plugins (whatsapp, telegram, discord)
│   └── {name}/             # Skill plugins
├── groups/
│   ├── main/               # Main group folder (CLAUDE.md, logs, conversations)
│   ├── global/             # Global CLAUDE.md (shared read-only to all groups)
│   └── {name}/             # Per-group isolated folders
├── data/
│   ├── ipc/{group}/        # Per-group IPC directories
│   │   ├── input/          # Follow-up messages to container
│   │   ├── messages/       # Outbound messages from container
│   │   └── tasks/          # Task commands from container
│   └── channels/{name}/    # Per-channel auth data
├── store/
│   ├── messages.db         # SQLite database
│   └── backups/            # Automatic DB backups
├── logs/                   # Application logs
└── .env                    # Configuration and secrets
```
