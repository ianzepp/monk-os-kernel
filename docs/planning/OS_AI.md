# Monk OS AI Layer

**Status: Needs Discussion**

This document captures early thinking on AI integration. Not finalized.

---

## Vision

The AI is the primary user interface. Users interact with an AI agent that can:

1. Execute shell commands (high-level)
2. Write and execute TypeScript (mid-level, direct syscalls)
3. Subscribe to system events and react (autonomous)

The AI lives in **userspace** but has deeper access than typical shell scripts.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  User                                                       │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  AI Process                                             ││
│  │                                                         ││
│  │  - Receives user input (console)                        ││
│  │  - Generates responses                                  ││
│  │  - Executes shell commands (via spawn)                  ││
│  │  - Executes TypeScript (via ???)                        ││
│  │  - Subscribes to events (via port)                      ││
│  │                                                         ││
│  └─────────────────────────────────────────────────────────┘│
│       │                                                     │
│       │ syscalls                                            │
│       ▼                                                     │
├─────────────────────────────────────────────────────────────┤
│  Kernel                                                     │
├─────────────────────────────────────────────────────────────┤
│  HAL                                                        │
└─────────────────────────────────────────────────────────────┘
```

## Capabilities

### 1. Shell Commands

Standard process spawning:

```typescript
const pid = await spawn('/bin/shell', { args: ['-c', 'ls -la /home'] });
const result = await wait(pid);
```

### 2. TypeScript Execution

AI generates TypeScript that makes syscalls directly:

```typescript
// AI generates this code
const files = await readdir('/data');
for (const name of files) {
  const info = await stat(`/data/${name}`);
  if (info.size > 1_000_000) {
    await unlink(`/data/${name}`);
  }
}
```

**Open question:** How does this execute?
- Eval in AI process (AI has kernel reference somehow?)
- New syscall: `exec(code: string)` runs TypeScript
- Spawn ephemeral worker with code

### 3. Event Subscriptions

AI subscribes to ports and reacts:

```typescript
// Watch for file changes
const watcher = await port('watch', { pattern: '/inbox/*' });

for await (const event of watcher) {
  // AI decides what to do with new file
  const content = await read(event.from);
  await processInboxItem(content);
}
```

```typescript
// React to pub/sub events
const bus = await port('pubsub', { subscribe: 'alerts.*' });

for await (const msg of bus) {
  // AI handles alert
  await respondToAlert(msg);
}
```

This enables autonomous behavior - AI isn't just reactive to user input.

## User Interaction

### Console Session

```
> find all log files larger than 10MB and summarize them

AI: Looking for large log files...

(executes)
  const logs = [];
  for (const f of await readdir('/var/log')) {
    const s = await stat(`/var/log/${f}`);
    if (s.size > 10_000_000) logs.push({ name: f, size: s.size });
  }

Found 3 files:
  - system.log (45 MB)
  - access.log (12 MB)
  - error.log (11 MB)

Summarizing...

(reads and analyzes each file)

Summary:
  - system.log: Mostly routine startup messages, 3 warnings about disk space
  - access.log: 50,000 requests, top endpoints: /api/users, /api/data
  - error.log: 127 errors, mostly timeout-related, spike at 3am

> delete the access log

AI: (executes)
  await unlink('/var/log/access.log');

Done.

> !shell

$ _
(user in direct shell)

$ exit

> (back to AI)
```

### Escape to Shell

User can drop to direct shell with `!shell` or similar escape.

## Autonomous Mode

AI can run background tasks:

```typescript
// Scheduled via port or timer
const timer = await port('timer', { interval: 3600_000 }); // hourly

for await (const tick of timer) {
  // Hourly maintenance
  await cleanupTempFiles();
  await rotateLogsIfNeeded();
}
```

```typescript
// React to system events
const proc = await port('process', { watch: 'all' });

for await (const event of proc) {
  if (event.data.event === 'exit' && event.data.code !== 0) {
    // Process crashed - AI decides response
    await notifyAdmin(event);
    await maybeRestart(event);
  }
}
```

## Open Questions

### 1. TypeScript Execution Model

How does AI-generated code run?

| Option | Pros | Cons |
|--------|------|------|
| Eval in AI process | Simple, direct | AI process needs kernel ref |
| `exec(code)` syscall | Clean separation | New syscall, security? |
| Spawn worker | Isolated | Overhead, needs code bundling |

### 2. Permission Model

Does AI have special capabilities? Or same as user that logged in?

| Option | Description |
|--------|-------------|
| Root equivalent | AI can do anything |
| User-scoped | AI has permissions of logged-in user |
| Escalation | AI can request elevation (sudo-style) |

### 3. Code Review / Approval

Should user approve AI-generated code before execution?

| Mode | Description |
|------|-------------|
| Auto | AI executes immediately (trust) |
| Review | AI shows code, user approves |
| Hybrid | Auto for safe ops, review for destructive |

### 4. Persistence

Does AI have memory across sessions?

- Conversation history?
- Learned preferences?
- Stored in VFS?

### 5. Multiple AI Instances

One AI per user session? Shared system AI? Both?

### 6. Timer Port

Do we need a `timer` port type for scheduled/periodic execution? Or is that userland (sleep loop)?

---

## Relationship to Existing Docs

- **OS_KERNEL.md**: AI is a userspace process, uses standard syscalls
- **OS_NETWORK.md**: AI uses ports for event subscription
- **OS_STORAGE.md**: AI uses VFS for file operations

The AI doesn't change the kernel design - it's a privileged consumer of it.
