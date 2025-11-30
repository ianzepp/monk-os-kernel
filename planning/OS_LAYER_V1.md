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

- **Plan 9**: Everything is a file. Database records appear as files.
- **BeOS**: Everything is a message. No polling—processes receive events naturally.
- **Monk**: Both, with pragmatic exceptions. Files for storage, messages for events, dedicated primitives for network I/O.

**Why network isn't a file:** TCP connections feel file-like (streams), but UDP is connectionless (datagrams with addresses), and listeners are factories that produce connections. Forcing `/dev/tcp/listen/8080` vs `/dev/tcp/127.0.0.1:8080` creates ugly asymmetry. Network gets its own syscalls. See [OS_NETWORK.md](./OS_NETWORK.md).

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

### Network Operations

Network uses dedicated syscalls, not VFS paths. See [OS_NETWORK.md](./OS_NETWORK.md) for full specification.

```typescript
interface Kernel {
  // TCP client → connected stream (FileHandle)
  connect(proto: 'tcp', host: string, port: number): Promise<FileHandle>;

  // Message-based I/O → Port
  port(type: PortType, opts: PortOpts): Promise<Port>;
}

type PortType = 'tcp:listen' | 'udp' | 'watch' | 'pubsub';
```

**Two primitives:**

| Primitive | Addressing | Methods | Examples |
|-----------|------------|---------|----------|
| FileHandle | Connected to one target | `read()`, `write()` | TCP conn, file, pipe |
| Port | Many sources/destinations | `recv()`, `send(to, data)` | UDP, TCP listener, watch, pub/sub |

### Ports (Message-Based I/O)

```typescript
interface Port {
  recv(): Promise<Message>;
  send(to: string, data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<Message>;
}

interface Message {
  from: string;      // source (address:port, path, topic)
  data: Uint8Array;  // payload (or FileHandle for TCP listener)
  meta?: unknown;    // op type, fields changed, etc.
}
```

**Examples:**

```typescript
// TCP server - listener yields FileHandles
const listener = await kernel.port('tcp:listen', { port: 8080 });
for await (const msg of listener) {
  const conn: FileHandle = msg.data;  // connected socket
  await conn.write(response);
}

// UDP - addressed datagrams
const sock = await kernel.port('udp', { bind: 9000 });
await sock.send('10.0.0.1:9001', data);
const msg = await sock.recv();  // msg.from = sender address

// File watch - path events
const watcher = await kernel.port('watch', { pattern: '/users/*' });
for await (const event of watcher) {
  // event.from = '/users/123', event.meta = { op: 'update' }
}

// Pub/Sub - topic messages
const bus = await kernel.port('pubsub', { subscribe: 'orders.*' });
await bus.send('orders.created', orderData);
```

### Unified Model: Writes ARE Events

```typescript
// Any path can be watched
const watcher = await kernel.port('watch', { pattern: '/users/*' });

// Write to path = event delivered to watchers
await kernel.write(fd, data);

// Watchers receive
const msg = await watcher.recv();
// { from: '/users/123', meta: { op: 'write' }, data: <what was written> }
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

## Kernel Architecture

The kernel manages three subsystems:

```
┌──────────────────────────────────────────────────────────────┐
│  Kernel                                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Message Router (Ports)                                │  │
│  │                                                        │  │
│  │  watch:/users/* ──► [IRC port, shell port, httpd port]│  │
│  │  pubsub:orders.* ─► [order-processor, audit-log]      │  │
│  │  tcp:listen:8080 ─► [httpd]                           │  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                          │                                   │
│         ┌────────────────┼────────────────┐                  │
│         ▼                ▼                ▼                  │
│  ┌────────────┐  ┌─────────────┐  ┌─────────────┐           │
│  │    VFS     │  │   Network   │  │  Scheduler  │           │
│  │  (files)   │  │ (sockets)   │  │ (processes) │           │
│  └────────────┘  └─────────────┘  └─────────────┘           │
└──────────────────────────────────────────────────────────────┘
```

**VFS** handles storage (files, folders, devices, /proc). Writes emit events to watch ports.

**Network** handles TCP/UDP via HAL. `connect()` returns FileHandle, `port()` returns Port.

**Scheduler** manages processes (Workers), their state, and syscall dispatch.

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
// httpd - HTTP server process (uses library over TCP)
async function httpd(kernel: Kernel) {
  const listener = await kernel.port('tcp:listen', { port: 9001 });

  for await (const msg of listener) {
    const conn: FileHandle = msg.data;
    // HTTP parsing is userland library over raw TCP
    const request = await parseHttpRequest(conn);
    const fd = await kernel.open(request.path, O_RDONLY);
    const data = await kernel.read(fd, Infinity);
    await sendHttpResponse(conn, 200, data);
    await conn.close();
  }
}

// telnetd - Telnet server process
async function telnetd(kernel: Kernel) {
  const listener = await kernel.port('tcp:listen', { port: 2323 });

  for await (const msg of listener) {
    const conn: FileHandle = msg.data;
    // Handle telnet session with raw read/write
    handleTelnetSession(kernel, conn);
  }
}

// ircd - IRC server process
async function ircd(kernel: Kernel) {
  const listener = await kernel.port('tcp:listen', { port: 6667 });
  const watcher = await kernel.port('watch', { pattern: '/users/*' });

  // Handle new connections
  handleConnections(listener);

  // Subscribe to data changes, broadcast to channels
  for await (const event of watcher) {
    broadcastToChannel('#users', formatIrcMessage(event));
  }
}
```

## Benefits

1. **Single executable deploys anywhere** — SQLite + embedded assets = one file
2. **Scale up transparently** — swap StorageEngine, same syscalls
3. **Hybrid mounts** — `/data` in VFS, `/host/uploads` passthrough to real FS
4. **Testability** — MemoryEngine + mock devices for fast unit tests
5. **No polling** — Ports receive events naturally
6. **Unified messaging** — file watch, pub/sub, network listeners all use Port
7. **Clean separation** — VFS for storage, Kernel for network, libraries for protocols

## What This Changes

| Old Mental Model | New Mental Model |
|-----------------|------------------|
| SQLite is "the database" | SQLite is raw block storage; VFS interprets it |
| HTTP/Telnet/SSH are "servers" | They're userland processes over TCP Ports |
| Event loop is "Node's thing" | It's the CPU scheduler |
| `bun build --compile` | Burning firmware |
| Separate pub/sub system | Writes ARE events (via watch Ports) |
| Network is files (`/dev/tcp/`) | Network is syscalls (`connect()`, `port()`) |

## Implementation Phases

### Phase 1: HAL Interfaces ✅
- Define BlockDevice, StorageEngine, NetworkDevice interfaces
- Implement SQLite and Postgres StorageEngine
- Implement all HAL devices (console, entropy, crypto, dns, etc.)

### Phase 2: VFS Core ✅
- Model interface with FileHandle
- FileModel, FolderModel, DeviceModel, ProcModel
- Grant-based ACL system

### Phase 3: Kernel Network (Partial ✅)
- ✅ Implement `connect()` syscall → FileHandle
- ✅ Implement `port()` syscall → Port
- ✅ Port type: `tcp:listen` (accept connections)
- ✅ Port type: `watch` (VFS file system events)
- ✅ Port type: `udp` (datagram send/receive)
- ⏳ Port type: `pubsub` (cross-process messaging)
- See [OS_NETWORK.md](./OS_NETWORK.md)

### Phase 4: Syscall Layer
- Define complete syscall interface
- Implement for in-process calls
- Implement for Worker message passing

### Phase 5: Server Migration
- Refactor httpd to use `port('tcp:listen')`
- Refactor telnetd to use `port('tcp:listen')`
- Migrate ircd from monk-irc

### Phase 6: Message-Driven Features
- Real-time updates via watch Ports
- Pub/sub for cross-process events
- Background job completion notifications
