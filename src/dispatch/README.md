# Syscall Module

The syscall layer is a switch-based routing system that separates syscall orchestration from kernel core responsibilities. It implements a clean architecture where each syscall function receives exactly what it needs as parameters, validates inputs, and yields responses through async generators.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Worker Process                                             │
│  └── postMessage({ type: 'syscall', name, args })           │
├─────────────────────────────────────────────────────────────┤
│  SyscallDispatcher                                          │
│  ├── onWorkerMessage() - entry point                        │
│  ├── execute() - wrap with StreamController                 │
│  └── dispatch() - switch-based routing                      │
├─────────────────────────────────────────────────────────────┤
│  Domain Handlers                                            │
│  ├── vfs.ts      - file:*, fs:* syscalls                    │
│  ├── ems.ts      - ems:* syscalls                           │
│  ├── process.ts  - proc:*, activation:* syscalls            │
│  ├── handle.ts   - handle:*, ipc:* syscalls                 │
│  ├── hal.ts      - net:*, port:*, channel:* syscalls        │
│  ├── pool.ts     - pool:*, worker:* syscalls                │
│  ├── auth.ts     - auth:* syscalls                          │
│  └── llm.ts      - llm:* syscalls                           │
├─────────────────────────────────────────────────────────────┤
│  StreamController (backpressure management)                 │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/syscall/
├── index.ts              # Module exports
├── types.ts              # Shared type definitions
├── dispatcher.ts         # Main syscall router
├── vfs.ts                # File system syscalls
├── ems.ts                # Entity Management System syscalls
├── process.ts            # Process lifecycle syscalls
├── handle.ts             # Handle manipulation & IPC syscalls
├── hal.ts                # Network/channel syscalls
├── pool.ts               # Worker pool syscalls
├── auth.ts               # Authentication syscalls
├── llm.ts                # LLM inference syscalls
└── stream/
    ├── index.ts          # Stream module exports
    ├── types.ts          # Stream types
    ├── constants.ts      # Flow control constants
    └── controller.ts     # StreamController implementation
```

## Design Principles

### Explicit Dependencies

Each syscall receives exactly what it needs as parameters:

```typescript
export async function* fileOpen(
    proc: Process,
    kernel: Kernel,
    vfs: VFS,
    path: unknown,
    flags?: unknown,
): AsyncIterable<Response> { ... }
```

### Yield Errors, Don't Throw

All syscalls return `AsyncIterable<Response>` and yield validation errors:

```typescript
if (typeof path !== 'string') {
    yield respond.error('EINVAL', 'path must be a string');
    return;
}
```

### Consistent Argument Ordering

Arguments follow pattern: `proc, kernel, [subsystem], [syscall-specific args]`

## Syscall Reference

### VFS Syscalls (`vfs.ts`)

| Syscall | Purpose |
|---------|---------|
| `file:open` | Open file, allocate fd |
| `file:close` | Close file descriptor |
| `file:read` | Read from file |
| `file:write` | Write to file |
| `file:seek` | Seek to position |
| `file:stat` | Get metadata by path |
| `file:setstat` | Set metadata by path |
| `file:fstat` | Get metadata by fd |
| `file:mkdir` | Create directory |
| `file:unlink` | Remove file/symlink |
| `file:rmdir` | Remove directory |
| `file:readdir` | List directory (streaming) |
| `file:rename` | Rename file/directory |
| `file:symlink` | Create symbolic link |
| `file:access` | Get/set ACL |
| `file:recv` | Receive message-based I/O |
| `file:send` | Send message-based I/O |
| `fs:mount` | Mount filesystem |
| `fs:umount` | Unmount filesystem |

---

### Process Syscalls (`process.ts`)

| Syscall | Purpose |
|---------|---------|
| `proc:spawn` | Spawn child process |
| `proc:exit` | Exit calling process |
| `proc:kill` | Send signal to process |
| `proc:wait` | Wait for child exit |
| `proc:getpid` | Get process ID |
| `proc:getppid` | Get parent PID |
| `proc:create` | Create virtual process |
| `proc:getargs` | Get process arguments |
| `proc:getcwd` | Get working directory |
| `proc:chdir` | Change working directory |
| `proc:getenv` | Get environment variable |
| `proc:setenv` | Set environment variable |
| `proc:tick:subscribe` | Subscribe to tick events |
| `proc:tick:unsubscribe` | Unsubscribe from tick events |
| `activation:get` | Get activation message |

---

### EMS Syscalls (`ems.ts`)

| Syscall | Purpose |
|---------|---------|
| `ems:describe` | Get schema information |
| `ems:select` | Query entities (streaming) |
| `ems:create` | Create new entity |
| `ems:update` | Update entity by ID |
| `ems:delete` | Soft delete entity |
| `ems:revert` | Restore soft-deleted entity |
| `ems:expire` | Hard delete entity |

---

### Handle/IPC Syscalls (`handle.ts`)

| Syscall | Purpose |
|---------|---------|
| `handle:redirect` | Redirect fd to another resource |
| `handle:restore` | Restore previously redirected fd |
| `handle:send` | Send message through handle |
| `handle:close` | Close handle |
| `ipc:pipe` | Create bidirectional message pipe |

---

### Network/Channel Syscalls (`hal.ts`)

| Syscall | Purpose |
|---------|---------|
| `net:connect` | TCP/Unix socket connection |
| `port:create` | Create message port |
| `port:close` | Close port |
| `port:recv` | Receive port message |
| `port:send` | Send port message |
| `channel:open` | Open protocol channel |
| `channel:close` | Close channel |
| `channel:call` | Call channel, get response |
| `channel:stream` | Stream channel responses |
| `channel:push` | Push response to channel |
| `channel:recv` | Receive from channel |
| `channel:accept` | Accept incoming channel connection |

**Supported Protocols:** tcp, unix, http, https, ws, wss, postgres, sqlite, sse

---

### Pool Syscalls (`pool.ts`)

| Syscall | Purpose |
|---------|---------|
| `pool:lease` | Lease worker from pool |
| `pool:stats` | Get pool statistics |
| `worker:load` | Load script into worker |
| `worker:send` | Send message to worker |
| `worker:recv` | Receive from worker |
| `worker:release` | Release worker to pool |

---

### Auth Syscalls (`auth.ts`)

| Syscall | Purpose |
|---------|---------|
| `auth:token` | Validate JWT, set process identity |
| `auth:whoami` | Get current user/session info |
| `auth:login` | Password login, create session |
| `auth:logout` | Clear session, reset identity |
| `auth:register` | Create user account |
| `auth:grant` | Mint scoped tokens (root only) |

**Auth Gating:** Most syscalls require authentication. Only `auth:login`, `auth:token`, and `auth:register` work for anonymous processes. Session expiry is checked lazily on each syscall.

---

### LLM Syscalls (`llm.ts`)

| Syscall | Purpose |
|---------|---------|
| `llm:complete` | Single-shot completion |
| `llm:stream` | Streaming completion |
| `llm:chat` | Chat completion |
| `llm:chat:stream` | Streaming chat completion |
| `llm:embed` | Generate embeddings |
| `llm:models` | List available models |

## Stream Controller

Manages consumer-driven backpressure to prevent unbounded memory growth.

### Flow Control Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `STREAM_HIGH_WATER` | 1000 | Pause at 1000 unacknowledged items |
| `STREAM_LOW_WATER` | 100 | Resume at 100 unacknowledged items |
| `STREAM_PING_INTERVAL` | 100ms | Consumer ping frequency |
| `STREAM_STALL_TIMEOUT` | 5000ms | Abort if no ping received |

### State Machine

```
[IDLE] --wrap()--> [STREAMING] --gap>=HIGH_WATER--> [PAUSED]
                        ^                               |
                        |------ ping(gap<=LOW_WATER)----
                        |
                   [TERMINATED] (done/cancel/stall)
```

### Key Methods

- `wrap(source)` - Wraps AsyncIterable with backpressure control
- `onPing(processed)` - Handle consumer acknowledgement
- `onCancel()` - Handle consumer cancellation

## SyscallDispatcher

Central routing class that connects workers to syscall handlers.

### Key Methods

| Method | Purpose |
|--------|---------|
| `dispatch(proc, name, args)` | Route syscall to handler |
| `execute(proc, name, args)` | Wrap dispatch with StreamController |
| `onWorkerMessage(proc, msg)` | Entry point for worker messages |
| `sendResponse(proc, id, response)` | Send response back to worker |

### Message Flow

```
Worker                    Kernel
  │                         │
  │──syscall request──────▶│
  │                         ├── dispatch()
  │                         ├── execute handler
  │◀──response stream──────│
  │──stream_ping──────────▶│ (every 100ms)
  │◀──more responses───────│
  │──stream_cancel────────▶│ (optional)
  │                         │
```

## Error Codes

| Code | Description |
|------|-------------|
| `EINVAL` | Invalid argument |
| `EBADF` | Bad file descriptor |
| `ENOENT` | File not found |
| `ENOTDIR` | Not a directory |
| `EPERM` | Permission denied |
| `EACCES` | Authentication required |
| `ESRCH` | Process not found |
| `ETIMEDOUT` | Operation timed out |
| `ENOSYS` | Syscall not implemented |
| `EIO` | Input/output error |
| `EFBIG` | File too large |

## Response Types

All syscalls yield `Response` objects:

| Response | Terminal | Usage |
|----------|----------|-------|
| `respond.ok(data)` | Yes | Success with data |
| `respond.error(code, msg)` | Yes | Error |
| `respond.item(entry)` | No | Stream item |
| `respond.done()` | Yes | Stream complete |
| `respond.data(bytes)` | No | Binary data chunk |
| `respond.event(event)` | No | Async notification |

## Public Exports

```typescript
export { SyscallDispatcher } from './dispatcher.js';
export { StreamController, StallError } from './stream/index.js';
export {
    STREAM_HIGH_WATER,
    STREAM_LOW_WATER,
    STREAM_PING_INTERVAL,
    STREAM_STALL_TIMEOUT
} from './stream/index.js';
export {
    respond,
    MAX_STREAM_ENTRIES,
    MAX_HANDLES,
    DEFAULT_CHUNK_SIZE
} from './types.js';
```
