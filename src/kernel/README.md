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
├── boot.ts               # Boot sequence
├── errors.ts             # Error definitions
├── services.ts           # Service definitions
├── mounts.ts             # Mount configuration loader
├── validate.ts           # Input validation utilities
├── poll.ts               # Polling utility
├── kernel/               # Modular kernel functions (56 files)
│   ├── Process lifecycle
│   │   ├── create-process.ts
│   │   ├── spawn-worker.ts
│   │   ├── spawn.ts
│   │   ├── exit.ts
│   │   ├── force-exit.ts
│   │   ├── kill.ts
│   │   └── deliver-signal.ts
│   ├── Handle management
│   │   ├── alloc-handle.ts
│   │   ├── get-handle.ts
│   │   ├── close-handle.ts
│   │   ├── ref-handle.ts
│   │   └── unref-handle.ts
│   ├── Resource creation
│   │   ├── create-port.ts
│   │   ├── create-pipe.ts
│   │   └── create-io-*.ts
│   └── Utilities
│       ├── printk.ts
│       ├── format-error.ts
│       └── load-services.ts
├── handle/               # I/O abstraction layer
│   ├── types.ts          # Handle interface
│   ├── file.ts           # FileHandleAdapter
│   ├── socket.ts         # SocketHandleAdapter
│   ├── port.ts           # PortHandleAdapter
│   ├── channel.ts        # ChannelHandleAdapter
│   ├── process-io.ts     # ProcessIOHandle
│   └── console.ts        # ConsoleHandleAdapter
├── resource/             # Port and pipe implementations
│   ├── types.ts          # Port interface
│   ├── listener-port.ts  # TCP listeners
│   ├── udp-port.ts       # UDP sockets
│   ├── watch-port.ts     # File system watchers
│   ├── pubsub-port.ts    # Pub/sub messaging
│   └── message-pipe.ts   # Inter-process pipes
├── loader/               # Module compilation
│   ├── vfs-loader.ts     # TypeScript bundler
│   ├── imports.ts        # Import resolution
│   ├── rewriter.ts       # Import rewriting
│   ├── cache.ts          # Module caching
│   └── types.ts          # Loader types
└── pool/                 # Worker pool management
    ├── pool.ts           # PoolManager
    └── pool-worker.ts    # Pool worker implementation
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
    id: string;                    // UUID
    parent: string;                // Parent UUID (empty for init)
    state: ProcessState;           // starting | running | stopped | zombie
    worker: Worker;                // Bun Worker instance
    handles: Map<number, string>;  // fd → handle ID
    children: Set<string>;         // Child process UUIDs
    activeStreams: Map<string, StreamState>;  // Backpressure tracking
    virtual?: boolean;             // Shares parent's Worker
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

Grace period: 5000ms between SIGTERM and SIGKILL during shutdown.

## Handle System

All I/O is unified through the Handle interface.

### Handle Types

| Type | Description | Implementations |
|------|-------------|-----------------|
| `file` | Regular files, devices, console | FileHandleAdapter |
| `socket` | Network sockets (TCP, UDP) | SocketHandleAdapter |
| `pipe` | Message-based IPC | MessagePipe |
| `port` | Structured message passing | PortHandleAdapter |
| `channel` | Protocol-aware I/O | ChannelHandleAdapter |

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
| `pubsub` | Topic-based pub/sub |
| `signal` | Signal handler |

### Port Interface

```typescript
interface Port {
    readonly id: string;
    readonly type: PortType;
    readonly closed: boolean;

    recv(): Promise<PortMessage>;
    send?(to: string, data: unknown): Promise<void>;
    close(): Promise<void>;
}
```

### Port Message Format

```typescript
interface PortMessage {
    from: string;      // Source identifier
    fd?: number;       // File descriptor (for socket accepts)
    data?: unknown;    // Message payload
    meta?: object;     // Metadata (timestamps, etc.)
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
        "stdin": { "type": "pubsub", "subscribe": ["log.*"] },
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

### Boot Sequence

1. Initialize HAL (hardware abstraction)
2. Initialize EMS (entity management)
3. Initialize VFS (virtual filesystem)
4. Create standard directories
5. Copy ROM to VFS
6. Load mount configuration
7. Load service definitions
8. Start activation loops
9. Spawn init process

### Shutdown Sequence

1. SIGTERM to all non-init processes
2. Wait grace period (5000ms)
3. SIGKILL remaining processes
4. Stop activation loops
5. Close activation ports
6. Shutdown worker pools
7. Clear all state

## Invariants

1. A process in 'zombie' state has no active worker
2. `handleRefs[id] >= 1` for any id in handles map
3. `proc.handles[fd]` references valid entry in kernel.handles
4. Init process exists from boot until shutdown
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
- `SyscallRequest`, `SyscallResponse`
- `PortType`, `PortOpts`, `PortMessage`
- `ServiceDef`, `Activation`, `ActivationType`
- `Handle`, `HandleType`

**Constants:**
- `SIGTERM = 15`, `SIGKILL = 9`
- `TERM_GRACE_MS = 5000`
- `MAX_HANDLES = 256`

**Errors:**
- `ProcessExited` - Thrown when process exits during syscall
- `ENOSYS`, `ECHILD`, `ESRCH` - Standard POSIX errors
