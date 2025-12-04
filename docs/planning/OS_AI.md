# Monk OS AI Layer

> **Status**: Feasible - Infrastructure Exists
> **Depends on**: None (all prerequisites implemented)

This document captures thinking on AI integration with Monk OS.

---

## Feasibility Assessment

### Infrastructure Already Implemented

| Capability | Status | Implementation |
|------------|--------|----------------|
| Process spawning | ✅ | `spawn()`, `wait()`, `kill()` in `rom/lib/process/proc.ts` |
| Shell commands | ✅ | Shell library with parsing, glob expansion |
| File operations | ✅ | Full VFS syscalls (open, read, write, stat, readdir, etc.) |
| Event subscriptions | ✅ | `WatchPort` for file events, `PubsubPort` for topic-based pub/sub |
| Module loader | ✅ | VFSLoader transpiles and executes TypeScript from VFS |
| Console I/O | ✅ | ConsoleHandle for stdin/stdout |
| Channel IPC | ✅ | Channel syscalls for inter-process communication |

### What's Missing

| Capability | Status | Notes |
|------------|--------|-------|
| Timer port | ❌ | No `timer` port type for scheduled execution |
| Dynamic code eval | ⚠️ | VFSLoader requires file in VFS, no `exec(code)` syscall |
| AI provider integration | ❌ | No HAL device for LLM API calls |

---

## Architecture (Updated for Current OS)

```
┌─────────────────────────────────────────────────────────────┐
│  User                                                       │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  AI Process (/bin/ai or similar)                        ││
│  │                                                         ││
│  │  - Receives user input (stdin via ConsoleHandle)        ││
│  │  - Calls LLM (via HAL channel or HTTP syscall)          ││
│  │  - Executes shell commands (spawn /bin/shell -c ...)    ││
│  │  - Executes TypeScript (write to /tmp, spawn)           ││
│  │  - Subscribes to events (WatchPort, PubsubPort)         ││
│  │                                                         ││
│  └─────────────────────────────────────────────────────────┘│
│       │                                                     │
│       │ syscalls                                            │
│       ▼                                                     │
├─────────────────────────────────────────────────────────────┤
│  Kernel (syscalls, handles, ports)                          │
├─────────────────────────────────────────────────────────────┤
│  HAL (console, file, channel, network)                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Capabilities (How They Work Today)

### 1. Shell Commands

Already works via `spawn()`:

```typescript
import { spawn, wait } from '/lib/process';

const pid = await spawn('/bin/shell', { args: ['-c', 'ls -la /home'] });
const result = await wait(pid);
```

### 2. TypeScript Execution

VFSLoader can load and execute TypeScript from VFS. AI-generated code can be:

**Option A: Write to temp file, spawn**
```typescript
import { open, write, close, spawn, wait, unlink } from '/lib/process';

// AI generates code
const code = `
import { readdir, stat, unlink } from '/lib/process';
// ... AI-generated logic
`;

// Write to temp file
const fd = await open('/tmp/ai_script.ts', { write: true, create: true });
await write(fd, new TextEncoder().encode(code));
await close(fd);

// Execute
const pid = await spawn('/tmp/ai_script.ts');
await wait(pid);

// Cleanup
await unlink('/tmp/ai_script.ts');
```

**Option B: Add `exec(code)` syscall** (not implemented)
```typescript
// Would require new syscall that writes to temp, spawns, and cleans up
await exec(`
  const files = await readdir('/data');
  for (const name of files) {
    // ...
  }
`);
```

### 3. Event Subscriptions

Already implemented via ports:

**File watching (WatchPort)**
```typescript
import { port } from '/lib/process';

// Watch for file changes
const watcher = await port('watch', { pattern: '/inbox/*' });

for await (const event of recv(watcher)) {
  // event.meta has: path, event (created/modified/deleted)
  const content = await read(event.meta.path);
  await processInboxItem(content);
}
```

**Pub/sub (PubsubPort)**
```typescript
import { port, recv } from '/lib/process';

// Subscribe to topic pattern
const bus = await port('pubsub', { subscribe: ['alerts.*'] });

for await (const msg of recv(bus)) {
  // Handle alert
  await respondToAlert(msg);
}
```

### 4. Periodic Tasks

**Current: Sleep loop (userland)**
```typescript
import { sleep } from '/lib/process';

while (true) {
  await cleanupTempFiles();
  await sleep(3600_000); // 1 hour
}
```

**Future: Timer port (not implemented)**
```typescript
// Would be cleaner with a timer port
const timer = await port('timer', { interval: 3600_000 });
for await (const tick of recv(timer)) {
  await cleanupTempFiles();
}
```

---

## Implementation Plan

### Phase 1: AI Process (Minimal)

Create `/bin/ai` that:
1. Reads user input from stdin
2. Calls external LLM API (via HTTP channel)
3. Parses LLM response for shell commands
4. Executes via `spawn('/bin/shell', { args: ['-c', command] })`

```typescript
// /bin/ai (simplified)
import { read, write, spawn, wait } from '/lib/process';
import { channel } from '/lib/process';

const llm = await channel.open('https', 'api.anthropic.com');

while (true) {
  // Read user input
  const input = await readLine(stdin);

  // Call LLM
  const response = await llm.call('POST', '/v1/messages', {
    model: 'claude-3-sonnet',
    messages: [{ role: 'user', content: input }]
  });

  // Parse and execute
  for (const command of parseCommands(response)) {
    const pid = await spawn('/bin/shell', { args: ['-c', command] });
    await wait(pid);
  }
}
```

### Phase 2: TypeScript Execution

Add convenience wrapper for AI-generated code:

```typescript
// /lib/ai.ts
export async function execCode(code: string): Promise<void> {
  const tempPath = `/tmp/ai_${Date.now()}.ts`;
  const fd = await open(tempPath, { write: true, create: true });
  await write(fd, new TextEncoder().encode(code));
  await close(fd);

  try {
    const pid = await spawn(tempPath);
    await wait(pid);
  } finally {
    await unlink(tempPath);
  }
}
```

### Phase 3: Event Integration

AI subscribes to system events:

```typescript
// AI with autonomous capabilities
const watcher = await port('watch', { pattern: '/inbox/*' });
const alerts = await port('pubsub', { subscribe: ['system.alerts.*'] });

// Handle events concurrently
await Promise.all([
  handleFileEvents(watcher),
  handleAlerts(alerts),
  handleUserInput(stdin),
]);
```

### Phase 4: Timer Port (Optional)

Add `timer` port type for cleaner scheduled execution:

```typescript
// src/kernel/resource/timer-port.ts
class TimerPort implements Port {
  private interval: number;
  private handle: Timer | null = null;

  constructor(opts: { interval: number }) {
    this.interval = opts.interval;
  }

  async *recv(): AsyncGenerator<PortMessage> {
    while (!this._closed) {
      await sleep(this.interval);
      yield { op: 'tick', data: { timestamp: Date.now() } };
    }
  }
}
```

---

## Open Questions (Updated)

### 1. TypeScript Execution Model

| Option | Feasibility | Notes |
|--------|-------------|-------|
| Write to temp, spawn | ✅ Works today | Slightly awkward but functional |
| `exec(code)` syscall | Easy to add | Syntactic sugar over option 1 |
| Eval in AI process | ❌ Complex | Would need kernel reference injection |

**Recommendation**: Start with temp file approach, add `exec()` syscall later.

### 2. Permission Model

| Option | Feasibility | Notes |
|--------|-------------|-------|
| User-scoped | ✅ Works today | AI inherits caller's permissions |
| Root equivalent | ⚠️ Risk | Run AI as privileged user |
| Escalation | Not implemented | Would need sudo syscall |

**Recommendation**: User-scoped for now. Add sudo later if needed.

### 3. Code Review / Approval

| Mode | Implementation |
|------|----------------|
| Auto | Just execute (current) |
| Review | AI prints code, waits for 'y' before executing |
| Hybrid | Categorize commands (safe vs destructive) |

**Recommendation**: Review mode for destructive operations (unlink, write).

### 4. LLM Integration

| Option | Implementation |
|--------|----------------|
| HTTP channel | ✅ Use existing channel.open('https', ...) |
| Dedicated HAL device | Could add `hal.llm` device |
| External process | Spawn separate LLM client process |

**Recommendation**: HTTP channel for MVP, consider HAL device later.

### 5. Persistence

| Feature | Implementation |
|---------|----------------|
| Conversation history | Write to `/home/user/.ai_history` |
| Preferences | Config file `/home/user/.airc` |
| Learned patterns | SQLite via EMS |

---

## Example Session

```
> find all log files larger than 10MB and summarize them

AI: I'll search for large log files and analyze them.

[Executing: ls -la /var/log]
[Executing: stat /var/log/system.log]
...

Found 3 files over 10MB:
  - system.log (45 MB)
  - access.log (12 MB)
  - error.log (11 MB)

[Reading and analyzing each file...]

Summary:
  - system.log: Routine startup messages, 3 disk space warnings
  - access.log: 50,000 requests, top: /api/users, /api/data
  - error.log: 127 errors, mostly timeouts, spike at 3am

> delete access.log

AI: This will permanently delete /var/log/access.log (12 MB).
Proceed? [y/N] y

[Executing: rm /var/log/access.log]

Done. File deleted.

> !shell

$ ls /var/log
system.log  error.log
$ exit

> (back to AI)
```

---

## References

- `src/kernel/resource/watch-port.ts` - File system event watching
- `src/kernel/resource/pubsub-port.ts` - Topic-based pub/sub
- `src/kernel/loader/vfs-loader.ts` - TypeScript module loading
- `rom/lib/process/proc.ts` - Process syscalls (spawn, wait, kill)
- `rom/lib/shell/` - Shell parsing and execution
