# Kernel Module

The kernel is the central coordinator for Monk OS, managing process lifecycle, handle allocation, service activation, and worker pools. It implements a microkernel design where syscall dispatch is delegated to a separate syscall layer, keeping the kernel focused on core resource management.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Syscall Layer (src/syscall/)                               │
│  ├── SyscallDispatcher (routing, StreamController)          │
│  └── Domain handlers (vfs, ems, hal, process, handle, pool) │
├─────────────────────────────────────────────────────────────┤
│  Kernel (process/handle management, service activation)     │
│  ├── ProcessTable (UUID → Process mapping)                  │
│  ├── HandleTable (reference-counted I/O handles)            │
│  ├── PoolManager (worker pools)                             │
│  └── ServiceActivation (tcp, udp, pubsub, watch, boot)      │
├─────────────────────────────────────────────────────────────┤
│  VFS / EMS / HAL                                            │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/kernel/
├── index.ts              # Public exports
├── kernel.ts             # Main Kernel class
├── types.ts              # Core type definitions
├── boot.ts               # ROM copy utilities
├── errors.ts             # Error definitions
├── services.ts           # Service definitions
├── mounts.ts             # Mount configuration loader
├── validate.ts           # Input validation utilities
├── poll.ts               # Polling utility
├── process-table.ts      # Process table implementation
├── pool.ts               # PoolManager class
├── pool-worker.ts        # Worker pool implementation
├── kernel/               # Modular kernel functions (58 files)
│   ├── Process lifecycle
│   │   ├── create-process.ts
│   │   ├── create-virtual-process.ts
│   │   ├── spawn-worker.ts
│   │   ├── spawn.ts
│   │   ├── exit.ts
│   │   ├── force-exit.ts
│   │   ├── kill.ts
│   │   ├── deliver-signal.ts
│   │   ├── interrupt-process.ts
│   │   ├── wait.ts
│   │   ├── notify-waiters.ts
│   │   ├── reap-zombie.ts
│   │   ├── get-pid.ts
│   │   └── get-ppid.ts
│   ├── Handle management
│   │   ├── alloc-handle.ts
│   │   ├── get-handle.ts
│   │   ├── close-handle.ts
│   │   ├── ref-handle.ts
│   │   ├── unref-handle.ts
│   │   ├── redirect-handle.ts
│   │   └── restore-handle.ts
│   ├── Resource creation
│   │   ├── create-port.ts
│   │   ├── create-pipe.ts
│   │   ├── create-io-source-handle.ts
│   │   ├── create-io-target-handle.ts
│   │   ├── open-file.ts
│   │   ├── open-channel.ts
│   │   ├── connect-tcp.ts
│   │   ├── accept-channel.ts
│   │   ├── get-port-from-handle.ts
│   │   └── get-channel-from-handle.ts
│   ├── Service management
│   │   ├── load-services.ts
│   │   ├── load-services-from-dir.ts
│   │   ├── activate-service.ts
│   │   ├── spawn-service-handler.ts
│   │   ├── run-activation-loop.ts
│   │   ├── setup-service-io.ts
│   │   ├── setup-service-stdio.ts
│   │   └── log-service-error.ts
│   ├── Worker pool
│   │   ├── lease-worker.ts
│   │   ├── get-leased-worker.ts
│   │   ├── load-worker.ts
│   │   ├── send-worker.ts
│   │   ├── recv-worker.ts
│   │   ├── release-worker.ts
│   │   └── release-process-workers.ts
│   ├── Mount management
│   │   ├── mount-fs.ts
│   │   ├── umount-fs.ts
│   │   ├── find-mount-policy-rule.ts
│   │   ├── matches-mount-rule.ts
│   │   └── matches-pattern.ts
│   ├── I/O and communication
│   │   ├── setup-init-stdio.ts
│   │   ├── setup-stdio.ts
│   │   ├── recv-port.ts
│   │   ├── publish-pubsub.ts
│   │   └── tick.ts
│   └── Utilities
│       ├── printk.ts
│       └── format-error.ts
├── handle/               # I/O abstraction layer
│   ├── index.ts          # Public exports
│   ├── types.ts          # Handle interface
│   ├── file.ts           # FileHandleAdapter
│   ├── socket.ts         # SocketHandleAdapter
│   ├── port.ts           # PortHandleAdapter
│   ├── channel.ts        # ChannelHandleAdapter
│   ├── process-io.ts     # ProcessIOHandle
│   └── console.ts        # ConsoleHandleAdapter
├── resource/             # Port and pipe implementations
│   ├── index.ts          # Public exports
│   ├── types.ts          # Port interface
│   ├── listener-port.ts  # TCP listeners
│   ├── udp-port.ts       # UDP sockets
│   ├── watch-port.ts     # File system watchers
│   ├── pubsub-port.ts    # Pub/sub messaging
│   └── message-pipe.ts   # Inter-process pipes
└── loader/               # Module compilation
    ├── index.ts          # Public exports
    ├── types.ts          # Loader types
    ├── vfs-loader.ts     # TypeScript bundler
    ├── imports.ts        # Import resolution
    ├── rewriter.ts       # Import rewriting
    └── cache.ts          # Module caching
```

## Process Model

Each process is a Bun Worker with UUID identity (not integer PID).

### Process States

```
[new] → starting → running → (stopped) → zombie → [reaped]
                      ↓
                   (signal)
```

### Process Structure

```typescript
interface Process {
    id: string;                    // UUID (kernel process has id='kernel')
    parent: string;                // Parent UUID (empty for kernel process)
    user: string;                  // User identity for ACL checks
    state: ProcessState;           // starting | running | stopped | zombie
    worker: Worker;                // Bun Worker instance
    virtual: boolean;              // Shares parent's Worker
    cmd: string;                   // Entry point / command
    cwd: string;                   // Working directory
    env: Record<string, string>;   // Environment variables
    args: string[];                // Command-line arguments
    pathDirs: Map<string, string>; // PATH directories (priority → path)
    handles: Map<number, string>;  // fd → handle UUID
    nextHandle: number;            // Next fd to allocate
    exitCode?: number;             // Exit code (when zombie)
    children: Map<number, string>; // PID → process UUID
    nextPid: number;               // Next PID to assign
    activeStreams: Map<string, AbortController>;  // Backpressure tracking
    streamPingHandlers: Map<string, (processed: number) => void>;
    activationMessage?: Message;   // Activation message for services

    // Auth identity (set by auth:token, cleared on expiry/logout)
    session?: string;              // Session ID from JWT
    expires?: number;              // Session expiry timestamp
    sessionValidatedAt?: number;   // Last EMS validation timestamp
    sessionData?: object;          // JWT claims or session metadata
}
```

### Standard File Descriptors

| fd | Name | Purpose |
|----|------|---------|
| 0 | recv | Messages in (stdin equivalent) |
| 1 | send | Messages out (stdout equivalent) |
| 2 | warn | Diagnostics (stderr equivalent) |

### Signals

| Signal | Value | Behavior |
|--------|-------|----------|
| SIGTERM | 15 | Graceful shutdown request |
| SIGKILL | 9 | Immediate termination |
| SIGTICK | 30 | Periodic tick for AI processes |

Grace period: 5000ms between SIGTERM and SIGKILL during shutdown.

### Virtual Processes

Virtual processes share their creator's Worker thread. This enables gatewayd to proxy syscalls for external clients, with each client getting isolated state (handles, cwd, env) while sharing gatewayd's Worker for transport.

When `virtual=true`:
- `worker` points to the creator's Worker (for response delivery)
- No `worker.terminate()` on exit (Worker belongs to creator)
- Syscalls specify `pid` explicitly (Worker → Process mapping is N:1)

## Handle System

All I/O is unified through the Handle interface.

### Handle Types

| Type | Description | Implementations |
|------|-------------|-----------------|
| `file` | Regular files, devices, console | FileHandleAdapter |
| `socket` | Network sockets (TCP, UDP) | SocketHandleAdapter |
| `pipe` | Message-based IPC | MessagePipe |
| `port` | Structured message passing | PortHandleAdapter |
| `channel` | Protocol-aware I/O (HTTP, WebSocket, PostgreSQL) | ChannelHandleAdapter |
| `process-io` | Direct I/O to a process | ProcessIOHandle |

### Handle Interface

```typescript
interface Handle {
    readonly id: string;
    readonly type: HandleType;
    readonly description: string;
    readonly closed: boolean;

    exec(msg: Message): AsyncIterable<Response>;
    close(): Promise<void>;
}
```

### Reference Counting

- Multiple processes can share handles (inherited stdio, pipes)
- `handleRefs` map tracks reference count per handle
- Handle closed only when refcount reaches 0
- Prevents premature resource closure

## Port System

Ports are event-driven message endpoints.

### Port Types

| Type | Description |
|------|-------------|
| `tcp:listen` | Accept TCP connections |
| `udp:bind` | UDP datagram socket |
| `fs:watch` | File system watcher |
| `pubsub:subscribe` | Topic-based pub/sub |
| `signal:catch` | Signal handler |
| `proc:watch` | Process state watcher |

### Port Interface

```typescript
interface Port {
    readonly id: string;
    readonly type: PortType;
    readonly description: string;
    readonly closed: boolean;

    recv(): Promise<PortMessage>;
    send(to: string, data?: Uint8Array, meta?: object): Promise<void>;
    close(): Promise<void>;
}
```

### Port Message Format

```typescript
interface PortMessage {
    from: string;        // Source identifier
    socket?: Socket;     // Accepted socket (tcp:listen only)
    data?: Uint8Array;   // Message payload (UDP, pubsub, watch)
    meta?: object;       // Metadata (timestamps, etc.)
}
```

## Service Activation

Services are spawned in response to events.

### Activation Types

| Type | Description | Example |
|------|-------------|---------|
| `boot` | Start at kernel boot | init services |
| `tcp:listen` | TCP connection received | telnetd |
| `udp:bind` | UDP datagram received | DNS server |
| `pubsub:subscribe` | Topic message published | log processor |
| `fs:watch` | File change detected | log rotator |

### Service Definition

```typescript
interface ServiceDef {
    handler: string;           // Path (e.g., "/svc/telnetd")
    activate: Activation;      // Trigger configuration
    io?: ServiceIO;           // stdin/stdout/stderr routing
    description?: string;
}
```

### Service Configuration

Services are defined in `/etc/services/*.json`:

```json
{
    "handler": "/svc/logd",
    "activate": { "type": "boot" },
    "io": {
        "stdin": { "type": "pubsub:subscribe", "topics": ["log.*"] },
        "stdout": { "type": "file", "path": "/var/log/system.log" },
        "stderr": { "type": "console" }
    }
}
```

## Worker Pools

Reusable Bun Workers for compute tasks.

### Pool Configuration

Defined in `/etc/pools.json`:

```json
{
    "freelance": { "min": 2, "max": 32, "idleTimeout": 15000 },
    "compute": { "min": 4, "max": 64, "idleTimeout": 30000 }
}
```

### Pool Lifecycle

```
[spawn] → idle → busy → [release] → idle
           ↓                         ↓
     [reap on timeout]        [reap on timeout]
```

### Pool Syscalls

- `pool:lease(poolName?)` - Get worker from pool
- `pool:stats()` - Get pool statistics
- `worker:load(workerId, path)` - Load script into worker
- `worker:send(workerId, msg)` - Send message to worker
- `worker:recv(workerId)` - Receive from worker
- `worker:release(workerId)` - Return worker to pool

## Module Loader

The VFSLoader compiles TypeScript and bundles for Worker execution.

### Three Phases

1. **Compilation**: TypeScript → JavaScript via Bun transpiler
2. **Resolution**: Walk imports, build dependency graph
3. **Bundling**: Assemble into single Worker script with CommonJS shim

### Module Caching

- Compiled modules cached by content hash
- Invalidated on source change
- Blob URLs cleaned up after Worker creation

## Kernel Lifecycle

### Init Sequence (kernel.init())

1. Create kernel process (PID 1) - always available, no Worker, `user: 'kernel'`
2. Mount /proc (synthetic filesystem backed by ProcessTable)
3. Load worker pool configuration
4. Load service definitions (no activation yet)

### Boot Sequence (kernel.boot())

1. Activate services (boot, tcp:listen, udp, pubsub, watch triggers)
2. Start tick broadcaster

Note: ROM copy and standard directories are handled by OS layer before kernel.init().

### Shutdown Sequence

1. SIGTERM to all non-init processes
2. Wait grace period (5000ms)
3. SIGKILL remaining processes
4. Stop tick broadcaster
5. Stop activation loops
6. Close activation ports
7. Clear all state
8. Shutdown worker pools

## Invariants

1. A process in 'zombie' state has no active worker
2. `handleRefs[id] >= 1` for any id in handles map
3. `proc.handles[fd]` references valid entry in kernel.handles
4. Kernel process (PID 1) exists from init until shutdown
5. Child's parent field always references valid process or empty string
6. No two processes share same UUID
7. Handle once closed never executes again

## Public Exports

**Classes:**
- `Kernel`
- `ProcessTable`
- `PoolManager`, `WorkerPool`

**Types:**
- `Process`, `ProcessState`, `SpawnOpts`, `ExitStatus`
- `SyscallRequest`, `SyscallResponse`, `SignalMessage`, `KernelMessage`
- `ProcessPortMessage`
- `PortType`, `PortOpts`, `PortMessage`
- `ServiceDef`, `Activation`, `ActivationType`, `HandlerEntry`
- `BootEnv`

**Constants:**
- `SIGTERM = 15`, `SIGKILL = 9`, `SIGTICK = 30`
- `TERM_GRACE_MS = 5000`
- `TICK_INTERVAL_MS = 1000`
- `MAX_HANDLES = 256`

**Errors:**
- `ProcessExited` - Thrown when process exits during syscall
- `ENOSYS`, `ECHILD`, `ESRCH`, `EBADF`, `EINVAL`, `EPERM` - Standard POSIX errors
