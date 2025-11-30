# Monk OS Layer v1

## Vision

Reframe the monk-api architecture: instead of "an API with servers," think "an operating system where Bun is the hardware."

The single-executable deployment (`bun build --compile`) isn't packaging an app—it's burning firmware.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Processes (Workers)                                        │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │ shell   │ │ httpd   │ │ telnetd │ │ ircd    │           │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘           │
│       │           │           │           │                 │
├───────┴───────────┴───────────┴───────────┴─────────────────┤
│  Syscall Interface                                          │
│  fs.read() → ?    net.listen() → ?    db.query() → ?       │
├─────────────────────────────────────────────────────────────┤
│  Kernel (message router, VFS, scheduler)                    │
├─────────────────────────────────────────────────────────────┤
│  Hardware Abstraction Layer (HAL)                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ BlockDevice    │ NetworkDevice   │ StorageEngine     │   │
│  │ ┌───────────┐  │ ┌────────────┐  │ ┌──────────────┐  │   │
│  │ │ SQLite    │  │ │ Bun.listen │  │ │ SQLite       │  │   │
│  │ │ LocalFS   │  │ │ Bun.serve  │  │ │ PostgreSQL   │  │   │
│  │ │ S3        │  │ └────────────┘  │ │ Memory       │  │   │
│  │ └───────────┘  │                 │ └──────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  Bun Runtime ("Hardware")                                   │
└─────────────────────────────────────────────────────────────┘
```

## Bun as Hardware

Instead of thinking "I'm stuck with Bun in my executable," think: "Bun IS my hardware platform."

| Traditional Hardware | Bun Equivalent |
|---------------------|----------------|
| CPU cores | `Worker` threads, event loop |
| RAM | `ArrayBuffer`, `SharedArrayBuffer` |
| Block device | `Bun.file()`, SQLite |
| Network interface | `Bun.listen()`, `Bun.serve()` |
| Timer/clock | `Bun.nanoseconds()`, `setTimeout` |
| Random generator | `crypto.getRandomValues()` |
| Console/serial | `process.stdout`, `process.stdin` |

## Design Principles

Inspired by Plan 9 and BeOS:

- **Plan 9**: Everything is a file. Database records appear as files. Network connections are files.
- **BeOS**: Everything is a message. No polling—processes receive events naturally.
- **Monk**: Both. The file IS the message channel. Writes to paths are events to watchers.

## Syscall Interface

### File Operations

```typescript
interface Kernel {
  open(path: string, flags: number): Promise<number>;
  read(fd: number, size: number): Promise<Uint8Array>;
  write(fd: number, data: Uint8Array): Promise<void>;
  close(fd: number): Promise<void>;
  stat(path: string): Promise<Stat>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
}
```

### Message Passing

```typescript
interface Kernel {
  // Watch a path for changes
  watch(path: string, opts?: WatchOpts): Promise<Port>;

  // Send/receive on ports
  send(port: Port, msg: Message): Promise<void>;
  recv(port: Port): Promise<Message>;  // blocks until message

  // Async iterator form
  messages(port: Port): AsyncIterable<Message>;
}

interface Message {
  path: string;
  op: 'create' | 'write' | 'delete' | 'rename' | 'chmod';
  data?: unknown;
  sender?: number;  // PID
  timestamp: number;
}
```

### Unified Model: Paths ARE Ports

```typescript
// Any path can be watched
const port = await kernel.watch('/users');

// Write to path = send to all watchers
await kernel.write(fd, data);  // Also delivers to watchers

// Watchers receive
const msg = await kernel.recv(port);
// { path: '/users/123', op: 'write', data: <what was written> }
```

### Plan 9 Style: /dev/watch

```typescript
// Watch via filesystem
const fd = await kernel.open('/dev/watch/users/*', O_RDONLY);

// Blocks until something happens to /users/*
while (true) {
  const msg = await kernel.read(fd, 4096);
  // msg = { path: '/users/123', op: 'write', data: {...} }
}
```

## Process Model

- Workers (Bun `Worker` threads) are processes to Monk OS
- Each process has a PID, environment, file descriptors
- Two syscall modes:
  - **Message passing**: For true Worker isolation, syscalls post to main thread
  - **Direct calls**: For in-process efficiency, process holds kernel reference

```typescript
// Message passing (Worker isolation)
function syscall(name: string, ...args: unknown[]): Promise<unknown> {
  const id = nextSyscallId++;
  postMessage({ type: 'syscall', id, name, args });
  return waitForResponse(id);
}

// Direct calls (same thread)
class Process {
  constructor(private kernel: Kernel) {}

  async run() {
    const fd = await this.kernel.open('/etc/passwd', O_RDONLY);
    const data = await this.kernel.read(fd, 1024);
  }
}
```

## Hardware Abstraction Layer

See [OS_HAL.md](./OS_HAL.md) for complete HAL specification.

The HAL is the lowest layer that can be written in TypeScript. It wraps Bun primitives to provide swappable, testable interfaces.

### HAL Devices

| Device | Purpose | Bun Primitive |
|--------|---------|---------------|
| BlockDevice | Raw byte storage | `Bun.file()`, SQLite |
| StorageEngine | Key-value + subscriptions | `bun:sqlite`, PostgreSQL |
| NetworkDevice | TCP/HTTP | `Bun.listen()`, `Bun.serve()` |
| TimerDevice | Scheduling, sleep | `setTimeout`, `Bun.sleep()` |
| ClockDevice | Wall/monotonic time | `Date.now()`, `Bun.nanoseconds()` |
| EntropyDevice | Randomness | `crypto.getRandomValues()` |
| CryptoDevice | Hash, encrypt | `Bun.hash()`, `crypto.subtle` |
| ConsoleDevice | stdin/stdout/stderr | `process.stdin/stdout/stderr` |
| EnvDevice | Environment vars | `Bun.env` |
| DNSDevice | Name resolution | `Bun.dns` |
| HostDevice | Escape to host OS | `Bun.spawn()` |
| IPCDevice | Shared memory, ports | `SharedArrayBuffer`, `MessagePort` |

### Naming Convention

- **Terse but greppable**: `genkey` not `generateKey`, but `semaphore` not `sema`
- **POSIX-style for I/O**: `read`, `write`, `stat`, `sync`
- **Domain-specific elsewhere**: `get`/`put` for key-value, `lookup` for DNS

## Kernel Message Router

The kernel is the central message bus. Writes to paths are delivered to all watchers.

```
┌──────────────────────────────────────────────────────────────┐
│  Kernel                                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Message Router                                        │  │
│  │                                                        │  │
│  │  /users/* ──────► [IRC port, shell port, httpd port]  │  │
│  │  /proc/42/notify ► [shell session 42]                 │  │
│  │  /dev/net/tcp ───► [telnetd, ircd, httpd]             │  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  VFS (writes go here AND to message router)             │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Configuration Modes

### Standalone (Fully Portable)

```typescript
const os = new MonkOS({
  storage: new SQLiteEngine(':memory:'),
  blocks: new SQLiteBlockDevice(db),
  network: new BunNetworkDevice(),
});
```

Single executable, no external dependencies. SQLite embedded, assets embedded.

### Production (External DB, FS Passthrough)

```typescript
const os = new MonkOS({
  storage: new PostgresEngine(process.env.DATABASE_URL),
  blocks: new LocalFSBlockDevice('/data'),
  network: new BunNetworkDevice(),
  mounts: {
    '/host': new LocalFSPassthrough('/var/monk'),
  },
});
```

PostgreSQL for scale, local filesystem passthrough for uploads/assets.

### Hybrid

Mix and match. VFS for structured data, passthrough for large files, external DB for multi-instance deployments.

## Server Processes

Servers become OS processes (daemons) that access resources through syscalls:

```typescript
// httpd - HTTP server process
async function httpd(kernel: Kernel) {
  const server = await kernel.network.serve(9001, async (req) => {
    const fd = await kernel.open(req.path, O_RDONLY);
    const data = await kernel.read(fd, Infinity);
    return new Response(data);
  });
}

// telnetd - Telnet server process
async function telnetd(kernel: Kernel) {
  const server = await kernel.network.listen(2323, {
    open(socket) { /* create session */ },
    data(socket, data) { /* handle input */ },
    close(socket) { /* cleanup */ },
  });
}

// ircd - IRC server process (migrated from monk-irc)
async function ircd(kernel: Kernel) {
  const server = await kernel.network.listen(6667, ircHandler);

  // Subscribe to data changes, broadcast to channels
  const port = await kernel.watch('/users');
  for await (const msg of kernel.messages(port)) {
    broadcastToChannel('#users', formatIrcMessage(msg));
  }
}
```

## Benefits

1. **Single executable deploys anywhere** — SQLite + embedded assets = one file
2. **Scale up transparently** — swap StorageEngine, same syscalls
3. **Hybrid mounts** — `/data` in VFS, `/host/uploads` passthrough to real FS
4. **Testability** — MemoryEngine + mock devices for fast unit tests
5. **No polling** — message passing is native to the OS
6. **Debugging** — `cat /dev/watch/users` shows events in real time
7. **Composition** — `watch /users | grep admin` is valid shell

## What This Changes

| Old Mental Model | New Mental Model |
|-----------------|------------------|
| SQLite is "the database" | SQLite is raw block storage; VFS interprets it |
| HTTP/Telnet/SSH are "servers" | They're device drivers exposing the system |
| Event loop is "Node's thing" | It's the CPU scheduler |
| `bun build --compile` | Burning firmware |
| Separate pub/sub system | Writes ARE events |

## Implementation Phases

### Phase 1: HAL Interfaces
- Define BlockDevice, StorageEngine, NetworkDevice interfaces
- Implement SQLite and Postgres StorageEngine
- Implement BunNetworkDevice

### Phase 2: Kernel Core
- Message router with path-based subscriptions
- Unified VFS that emits events on writes
- Process table and PID management

### Phase 3: Syscall Layer
- Define syscall interface
- Implement for in-process calls
- Implement for Worker message passing

### Phase 4: Server Migration
- Refactor httpd to use syscalls
- Refactor telnetd to use syscalls
- Migrate ircd from monk-irc

### Phase 5: Message-Driven Features
- Real-time updates in shell sessions
- IRC channel auto-updates from DB changes
- Background job completion notifications
