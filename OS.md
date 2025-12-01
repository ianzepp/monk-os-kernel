# Monk OS Architecture

Monk OS is an operating system where **Bun is the hardware**. The single-executable deployment
(`bun build --compile`) isn't packaging an app—it's burning firmware.

## Philosophy

Inspired by Plan 9 and BeOS:

- **Plan 9**: Everything is a file. Database records appear as files.
- **BeOS**: Everything is a message. No polling—processes receive events naturally.
- **Monk**: Both, with pragmatic exceptions. Files for storage, messages for events,
  dedicated primitives for network I/O.

**Core principles:**
- UUID-first identity (UUID v7 for timestamp ordering)
- TypeScript is the native scripting language
- Everything runs as isolated Worker processes
- Grant-based ACLs (not UNIX permission bits)
- Network is NOT part of VFS (separate syscalls)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Processes (Workers)                                        │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │  init   │ │  shell  │ │ telnetd │ │  httpd  │           │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘           │
│       │           │           │           │                 │
│       └───────────┴───────────┴───────────┘                 │
│                           │                                 │
│                    HAL IPCDevice                            │
│                    (syscall transport)                      │
│                           │                                 │
├───────────────────────────┴─────────────────────────────────┤
│  Kernel                                                     │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                   Syscall Dispatch                      ││
│  └─────────────────────────────────────────────────────────┘│
│       │              │              │              │        │
│       ▼              ▼              ▼              ▼        │
│  ┌─────────┐  ┌───────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Process │  │    VFS    │  │ Network  │  │  Message   │  │
│  │  Table  │  │           │  │          │  │  Router    │  │
│  └─────────┘  └───────────┘  └──────────┘  └────────────┘  │
│                     │              │                        │
├─────────────────────┴──────────────┴────────────────────────┤
│  HAL                                                        │
│  StorageEngine, NetworkDevice, IPCDevice, etc.              │
└─────────────────────────────────────────────────────────────┘
```

**Source files:**
- Kernel: `src/kernel/kernel.ts`
- Process Table: `src/kernel/process-table.ts`
- Syscalls: `src/kernel/syscalls.ts`
- Resources: `src/kernel/resource.ts`
- Types: `src/kernel/types.ts`
- Errors: `src/kernel/errors.ts`

---

## Hardware Abstraction Layer (HAL)

The HAL is the lowest layer written in TypeScript. It wraps Bun primitives to provide
swappable, testable interfaces for the kernel.

```
┌─────────────────────────────────────────┐
│  Kernel, Syscalls, Processes            │
├─────────────────────────────────────────┤
│  HAL                                    │  ◄── Lowest you can write
├─────────────────────────────────────────┤
│  Bun APIs                               │  ◄── You call these, can't replace
├─────────────────────────────────────────┤
│  Bun internals (Zig + JavaScriptCore)   │
├─────────────────────────────────────────┤
│  Host OS                                │
├─────────────────────────────────────────┤
│  Physical Hardware                      │
└─────────────────────────────────────────┘
```

### HAL Aggregate Interface

```typescript
interface HAL {
    block: BlockDevice;       // Raw byte storage
    storage: StorageEngine;   // Key-value + subscriptions
    network: NetworkDevice;   // TCP/HTTP connections
    timer: TimerDevice;       // Scheduling, sleep
    clock: ClockDevice;       // Wall/monotonic time
    entropy: EntropyDevice;   // Randomness, UUIDs
    crypto: CryptoDevice;     // Hash, encrypt, key derive
    console: ConsoleDevice;   // stdin/stdout/stderr
    dns: DNSDevice;           // Name resolution
    host: HostDevice;         // Escape to host OS
    ipc: IPCDevice;           // Shared memory, ports
}
```

### Device Overview

| Device | Purpose | Bun Primitive |
|--------|---------|---------------|
| BlockDevice | Raw byte storage | `Bun.file()`, SQLite |
| StorageEngine | Key-value + subscriptions | `bun:sqlite`, PostgreSQL |
| NetworkDevice | TCP/HTTP | `Bun.listen()`, `Bun.serve()` |
| TimerDevice | Scheduling, sleep | `setTimeout`, `Bun.sleep()` |
| ClockDevice | Wall/monotonic time | `Date.now()`, `Bun.nanoseconds()` |
| EntropyDevice | Randomness | `crypto.getRandomValues()` |
| CryptoDevice | Hash, encrypt | `Bun.hash()`, `crypto.subtle` |
| ConsoleDevice | Console I/O | `process.stdin/stdout/stderr` |
| DNSDevice | DNS lookup | `Bun.dns` |
| HostDevice | Host OS escape | `Bun.spawn()` |
| IPCDevice | Shared memory | `SharedArrayBuffer`, `Atomics` |

**Source files:**
- Index: `src/hal/index.ts`
- Block: `src/hal/block.ts`
- Storage: `src/hal/storage.ts`
- Network: `src/hal/network.ts`
- Timer: `src/hal/timer.ts`
- Clock: `src/hal/clock.ts`
- Entropy: `src/hal/entropy.ts`
- Crypto: `src/hal/crypto.ts`
- Console: `src/hal/console.ts`
- DNS: `src/hal/dns.ts`
- Host: `src/hal/host.ts`
- IPC: `src/hal/ipc.ts`
- Errors: `src/hal/errors.ts`

**Tests:** `spec/hal/*.test.ts`

---

## Virtual File System (VFS)

**Everything is a file. Everything is a database. Files are database rows.**

The VFS manages:
- Mount table (path prefix → Model)
- Path resolution (path → entity UUID)
- Access control enforcement
- Quota tracking

### Core Concepts

#### Model

A Model defines how a class of files behaves:

```typescript
interface Model {
    name: string;                          // 'file', 'folder', 'device'
    fields(): FieldDef[];                  // Schema definition
    open(ctx, id, flags): FileHandle;      // Open for I/O
    stat(ctx, id): ModelStat;              // Get metadata
    setstat(ctx, id, fields): void;        // Update metadata
    create(ctx, parent, name, fields): id; // Create entity
    unlink(ctx, id): void;                 // Remove entity
    list(ctx, id): AsyncIterable<string>;  // List children
    watch?(ctx, id, pattern): AsyncIterable<WatchEvent>;
}
```

#### FileHandle

Result of opening a path, provides I/O operations:

```typescript
interface FileHandle {
    read(size?: number): Promise<Uint8Array>;
    write(data: Uint8Array): Promise<number>;
    seek?(offset, whence): Promise<number>;
    sync(): Promise<void>;
    close(): Promise<void>;
}
```

### Built-in Models

| Model | Purpose | Backing Store |
|-------|---------|---------------|
| FileModel | Standard files | StorageEngine |
| FolderModel | Directories | StorageEngine |
| DeviceModel | Hardware devices | HAL devices |
| ProcModel | Process info | Kernel state |
| LinkModel | Symbolic links | StorageEngine (disabled) |

**Note:** LinkModel exists but `create()` throws EPERM. Symbolic links are not currently
supported. The model is scaffolded for future implementation.

### Entity Metadata (ModelStat)

```typescript
interface ModelStat {
    id: string;           // UUID v7 identity
    model: string;        // Model type
    name: string;         // Filename (not full path)
    parent: string|null;  // Parent folder UUID
    owner: string;        // Creator UUID
    size: number;         // Bytes (for files)
    mtime: number;        // Modification time
    ctime: number;        // Creation time
    data?: string;        // Blob UUID (for files)
    // ... additional model-specific fields
}
```

### Path Resolution

Paths are computed by walking the parent chain. There is no stored `path` field.

- `/home/user/doc.txt` → resolve by traversing `name` + `parent` chain
- Moving a file = updating `parent` field only
- Renaming a file = updating `name` field only
- Uniqueness enforced by `(parent, name)` constraint

### Access Control (ACL)

Grant-based permissions, not UNIX permission bits:

```typescript
interface ACL {
    grants: Grant[];      // Explicit permissions
    deny: string[];       // Explicit denies (always wins)
}

interface Grant {
    to: string;           // Who (UUID, or '*' for everyone)
    ops: string[];        // Operations: 'read', 'write', 'delete', '*'
    expires?: number;     // Optional expiration
}
```

**Access check flow:**
1. Check if caller in `deny[]` → EPERM
2. Check if caller has required ops in `grants[]` → proceed
3. No match → EPERM

Permission is checked once at `open()`. The FileHandle **is** the capability.

**Source files:**
- VFS: `src/vfs/vfs.ts`
- Model: `src/vfs/model.ts`
- Handle: `src/vfs/handle.ts`
- ACL: `src/vfs/acl.ts`
- FileModel: `src/vfs/models/file.ts`
- FolderModel: `src/vfs/models/folder.ts`
- DeviceModel: `src/vfs/models/device.ts`
- ProcModel: `src/vfs/models/proc.ts`
- LinkModel: `src/vfs/models/link.ts`

**Tests:** `spec/vfs/*.test.ts`

---

## Kernel

The Kernel is the central coordinator. It manages:
- **Processes** - creation, lifecycle, termination
- **VFS** - delegates file operations to VFS layer
- **Network** - TCP connections and Ports
- **Message Router** - connects Ports to event sources
- **Services** - socket-activated daemon management

### Process Model

Processes are **Bun Workers**. This provides:
- **Isolation** - separate memory, can't corrupt kernel or other processes
- **Killable** - `worker.terminate()` stops immediately
- **Message-based syscalls** - all kernel interaction via HAL IPCDevice

```typescript
interface Process {
    id: string;                        // UUID identity
    parent: string;                    // Parent UUID
    worker: Worker;                    // Bun Worker
    state: ProcessState;               // 'starting'|'running'|'stopped'|'zombie'
    cmd: string;                       // Entry point
    cwd: string;                       // Working directory
    env: Record<string, string>;       // Environment
    args: string[];                    // Command-line arguments
    fds: Map<number, string>;          // fd → resource UUID
    ports: Map<number, string>;        // portId → port UUID
    nextFd: number;                    // Next fd to allocate
    nextPort: number;                  // Next port to allocate
    children: Map<number, string>;     // child PID → child UUID
    nextPid: number;                   // Next child PID
    exitCode?: number;                 // Exit code (when zombie)
}
```

### File Descriptors

Processes use small integers for fds (POSIX-style). The kernel maps these to UUIDs.

| fd | Standard Resource |
|----|-------------------|
| 0 | stdin |
| 1 | stdout |
| 2 | stderr |

### Resource Abstraction

Resources unify different I/O types under a common interface:

```typescript
interface Resource {
    id: string;
    type: 'file' | 'socket' | 'pipe';
    description: string;
    read(size?: number): Promise<Uint8Array>;
    write(data: Uint8Array): Promise<number>;
    close(): Promise<void>;
    closed: boolean;
}
```

Resource types:
- `FileResource` - wraps VFS FileHandle
- `SocketResource` - wraps HAL Socket (TCP)
- `PipeResource` - wraps PipeBuffer (inter-process)

### Signals

Minimal signal support:

| Signal | Value | Meaning |
|--------|-------|---------|
| SIGTERM | 15 | Graceful shutdown request |
| SIGKILL | 9 | Immediate termination (not catchable) |

### Process Lifecycle

**Spawn:**
1. Create Process structure with inherited env, cwd
2. Setup stdio (inherit or redirect)
3. Create Worker via HAL
4. Wire up syscall handling
5. Register in process table
6. Return PID to parent

**Exit:**
1. Set exitCode, state='zombie'
2. Close all file descriptors (with refcounting)
3. Close all ports
4. Terminate worker
5. Reparent children to init
6. Notify waiters

**Source files:**
- Kernel: `src/kernel/kernel.ts`
- Process Table: `src/kernel/process-table.ts`
- Types: `src/kernel/types.ts`
- Errors: `src/kernel/errors.ts`

**Tests:** `spec/kernel/*.test.ts`

---

## Network Architecture

**Network is NOT part of VFS.** TCP connections feel file-like, but:
- UDP is connectionless (datagrams with addresses)
- Listeners are factories (produce connections, aren't connections)
- Path asymmetry is ugly (`/dev/tcp/listen/8080` vs `/dev/tcp/127.0.0.1:8080`)

Network has dedicated kernel syscalls returning two primitives:
- **FileHandle** for connected streams (TCP connections)
- **Port** for message-based I/O (UDP, listeners, watch, pub/sub)

### Two Primitives

| Primitive | Addressing | Methods | Examples |
|-----------|------------|---------|----------|
| FileHandle | Connected | `read()`, `write()` | TCP conn, file, pipe |
| Port | Many sources | `recv()`, `send(to)` | UDP, listener, watch |

### Port Interface

```typescript
interface Port {
    id: string;
    type: PortType;
    description: string;
    recv(): Promise<PortMessage>;
    send(to: string, data: Uint8Array): Promise<void>;
    close(): Promise<void>;
}

interface PortMessage {
    from: string;
    data?: Uint8Array;
    socket?: Socket;    // For tcp:listen
    meta?: Record<string, unknown>;
}
```

### Port Types

| Type | Options | Description |
|------|---------|-------------|
| `tcp:listen` | port, host?, backlog? | Accept TCP connections |
| `udp` | bind | Send/recv datagrams |
| `watch` | pattern | File system events |
| `pubsub` | subscribe | Topic-based messaging |

### TCP Server Example

```typescript
const listener = await kernel.port('tcp:listen', { port: 8080 });
for await (const msg of listener) {
    const conn = msg.socket;  // Connected socket
    await conn.write(response);
    await conn.close();
}
```

### Pub/Sub Topic Patterns

- `orders.created` - exact match
- `orders.*` - one level wildcard
- `orders.>` - multi-level wildcard

**Source files:**
- Resource/Port types: `src/kernel/resource.ts`
- Network syscalls: `src/kernel/syscalls.ts`
- HAL Network: `src/hal/network.ts`

**Tests:** `spec/kernel/network.test.ts`

---

## Syscall Interface

Syscalls travel through HAL IPCDevice as messages:

```typescript
// Request (process → kernel)
interface SyscallRequest {
    type: 'syscall';
    id: string;      // UUID for correlation
    name: string;    // Syscall name
    args: unknown[]; // Arguments
}

// Response (kernel → process)
interface SyscallResponse {
    type: 'response';
    id: string;
    result?: unknown;
    error?: { code: string; message: string };
}
```

### Syscall Categories

#### Process Management

| Syscall | Arguments | Returns | Description |
|---------|-----------|---------|-------------|
| `spawn` | entry, opts? | pid | Create child process |
| `exit` | code | never | Terminate process |
| `kill` | pid, signal? | void | Send signal |
| `wait` | pid | ExitStatus | Wait for child |
| `getpid` | - | pid | Current PID |
| `getppid` | - | pid | Parent PID |

#### File Operations

| Syscall | Arguments | Returns | Description |
|---------|-----------|---------|-------------|
| `open` | path, flags | fd | Open file |
| `close` | fd | void | Close descriptor |
| `read` | fd, size? | Uint8Array | Read data |
| `write` | fd, data | number | Write data |
| `seek` | fd, offset, whence | number | Seek in file |
| `stat` | path | Stat | Get metadata |
| `mkdir` | path | void | Create directory |
| `unlink` | path | void | Delete file |
| `readdir` | path | string[] | List directory |
| `symlink` | target, path | void | Create symlink (disabled) |
| `access` | path, acl? | ACL | Read/set ACL |

#### Pipes

| Syscall | Arguments | Returns | Description |
|---------|-----------|---------|-------------|
| `pipe` | - | [readFd, writeFd] | Create pipe pair |
| `redirect` | target, source | savedId | Redirect fd |
| `restore` | target, saved | void | Restore fd |

#### Network

| Syscall | Arguments | Returns | Description |
|---------|-----------|---------|-------------|
| `connect` | proto, host, port | fd | Connect stream |
| `port` | type, opts | portId | Create port |
| `recv` | portId | Message | Receive message |
| `send` | portId, to, data | void | Send message |
| `pclose` | portId | void | Close port |

#### Environment

| Syscall | Arguments | Returns | Description |
|---------|-----------|---------|-------------|
| `getcwd` | - | string | Working directory |
| `chdir` | path | void | Change directory |
| `getenv` | name | string? | Get env var |
| `setenv` | name, value | void | Set env var |
| `getargs` | - | string[] | Get argv |

**Source files:**
- Syscall dispatch: `src/kernel/syscalls.ts`
- Process library: `src/process/index.ts`
- Syscall transport: `src/process/syscall.ts`
- Error types: `src/process/errors.ts`

**Tests:** `spec/kernel/syscalls.test.ts`

---

## Shell and Scripting

TypeScript is the native scripting language. No bash, no sh.

### Shell Features

| Feature | Status | Notes |
|---------|--------|-------|
| Command parsing | Done | Via `src/lib/shell/` |
| Variable expansion | Done | `$VAR`, `${VAR:-default}`, `~` |
| Glob expansion | Done | `*`, `?`, `[...]` |
| Pipes (`\|`) | Done | Uses kernel `pipe()` syscall |
| Chaining (`&&`, `\|\|`) | Done | Short-circuit evaluation |
| Redirects (`<`, `>`, `>>`) | Done | Uses `redirect()` syscall |
| Background (`&`) | Pending | Requires job control |

### Built-in Commands

| Command | Description |
|---------|-------------|
| `cd` | Change directory |
| `pwd` | Print working directory |
| `export` | Set environment variable |
| `history` | Show command history |
| `exit` | Exit shell |
| `echo` | Output text |
| `true` | Return success (0) |
| `false` | Return failure (1) |

### External Commands

Located in `/bin/`:
- `awk` - pattern scanning and text processing
- `cat` - concatenate files
- `chmod` - change permissions (disabled, use `grant`)
- `cp` - copy files
- `grant` - manage ACLs (Monk-native)
- `ln` - create links (disabled, returns EPERM)
- `ls` - list directory
- `mkdir` - create directory
- `mv` - move/rename files
- `rm` - remove files
- `rmdir` - remove directory
- `sed` - stream editor
- `touch` - create empty file
- `shell` - the shell itself
- `init` - init process
- `httpd` - HTTP daemon
- `telnetd` - telnet daemon

**Source files:**
- Shell: `src/bin/shell.ts`
- Init: `src/bin/init.ts`
- Commands: `src/bin/*.ts`

**Tests:** `spec/kernel/shell.test.ts`

---

## Service Management

Services are socket-activated daemons defined in `/etc/services/*.json`.

### Service Definition

```typescript
interface ServiceDef {
    handler: string;       // Handler path (e.g., '/bin/telnetd')
    activate: Activation;  // Activation trigger
    description?: string;
}

type Activation =
    | { type: 'boot' }                              // Start immediately
    | { type: 'tcp:listen'; port: number; host?: string }
    | { type: 'udp'; port: number; host?: string }
    | { type: 'watch'; pattern: string }
    | { type: 'pubsub'; topic: string };
```

### Activation Types

| Type | Description | fd 0 receives |
|------|-------------|---------------|
| `boot` | Spawn at kernel boot | Console |
| `tcp:listen` | Spawn on TCP connection | Connected socket |
| `udp` | Spawn on UDP datagram | JSON datagram |
| `watch` | Spawn on file change | JSON event |
| `pubsub` | Spawn on message | JSON message |

### Handler Registry

Bundled handlers are registered at compile time (no VFS-based execution yet):

```typescript
const handlers = new HandlerRegistry();
handlers.register('/bin/telnetd', 'src/bin/telnetd.ts');
handlers.register('/bin/shell', 'src/bin/shell.ts');
```

### Example Service

```json
{
    "handler": "/bin/telnetd",
    "activate": {
        "type": "tcp:listen",
        "port": 2323
    },
    "description": "Telnet server for shell access"
}
```

**Source files:**
- Services: `src/kernel/services.ts`
- Service loading: `src/kernel/kernel.ts` (loadServices, activateService)

---

## Boot Sequence

1. HAL initialization
2. VFS initialization (root folder, /dev devices)
3. Service loading from `/etc/services/`
4. Service activation (create listeners, start boot services)
5. Init process creation
6. Init stdio setup (console)
7. Init worker spawn

**Boot environment:**

```typescript
interface BootEnv {
    initPath: string;             // Path to init (e.g., '/bin/init')
    initArgs?: string[];          // Init arguments
    env?: Record<string, string>; // Initial environment
}
```

**After boot:**
1. Kernel running
2. VFS available
3. Network available
4. Services activated
5. Init process running

---

## Configuration Modes

### Standalone (Fully Portable)

```typescript
const hal = await createBunHAL({
    storage: { type: 'memory' }
});
```

Single executable, no external dependencies.

### SQLite (Persistent)

```typescript
const hal = await createBunHAL({
    storage: { type: 'sqlite', path: '/data/monk.db' }
});
```

Embedded SQLite for persistence.

### PostgreSQL (Production)

```typescript
const hal = await createBunHAL({
    storage: { type: 'postgres', url: process.env.DATABASE_URL }
});
```

PostgreSQL for scale and multi-instance.

---

## Resource Limits

| Resource | Limit |
|----------|-------|
| Max file descriptors per process | 256 |
| Max ports per process | 64 |
| Signal grace period | 5000ms |

**Source:** `src/kernel/types.ts`

---

## Testing

Test files are located in `spec/` mirroring the `src/` structure:

| Component | Test Location |
|-----------|---------------|
| HAL devices | `spec/hal/*.test.ts` |
| VFS | `spec/vfs/*.test.ts` |
| Kernel | `spec/kernel/*.test.ts` |

### Key Test Files

- `spec/kernel/boot.test.ts` - Boot sequence
- `spec/kernel/spawn.test.ts` - Process spawning
- `spec/kernel/syscalls.test.ts` - Syscall dispatch
- `spec/kernel/network.test.ts` - Network primitives
- `spec/kernel/shell.test.ts` - Shell features
- `spec/kernel/resource.test.ts` - Resource/pipe handling
- `spec/vfs/vfs.test.ts` - VFS operations
- `spec/vfs/acl.test.ts` - Access control
- `spec/hal/storage.test.ts` - Storage engine

### Running Tests

```bash
bun test                    # All tests
bun test spec/kernel/       # Kernel tests only
bun test spec/vfs/          # VFS tests only
bun test spec/hal/          # HAL tests only
```

---

## Implementation Status

### Complete

- HAL (all devices)
- VFS (file, folder, device, proc models)
- Grant-based ACL
- Kernel (process table, syscall dispatch)
- Resource abstraction (files, sockets, pipes)
- Network (`connect()`, all port types)
- Shell (parsing, pipes, redirects, chaining)
- Service management (socket activation)
- Boot sequence
- VFS-backed script execution (loader with import rewriting)
- Telnet shell access (`nc localhost 2323`)

### Pending

- Background jobs (`&`) - requires job control
- Message router optimization
- PostgreSQL storage engine
- Process capabilities
- File versioning (optional feature)
- AI integration (needs discussion)

---

## Planning Documents

Detailed specifications in `planning/`:

| Document | Description |
|----------|-------------|
| `OS_KERNEL.md` | Kernel architecture, process model |
| `OS_HAL.md` | Hardware abstraction layer |
| `OS_STORAGE.md` | VFS, models, ACL, quotas |
| `OS_NETWORK.md` | Network primitives, ports |
| `OS_PROCESS.md` | Process library |
| `OS_SCRIPTING.md` | Shell, TypeScript scripting |
| `OS_AI.md` | AI integration (draft) |
| `OS_LAYER_V1.md` | Overall vision and phases |

---

## Quick Reference

### Bun as Hardware

| Traditional Hardware | Bun Equivalent |
|---------------------|----------------|
| CPU cores | Worker threads, event loop |
| RAM | `ArrayBuffer`, `SharedArrayBuffer` |
| Block device | `Bun.file()`, SQLite |
| Network interface | `Bun.listen()`, `Bun.serve()` |
| Timer/clock | `Bun.nanoseconds()`, `setTimeout` |
| Random generator | `crypto.getRandomValues()` |
| Console/serial | `process.stdout`, `process.stdin` |

### File Structure

```
src/
├── hal/              # Hardware Abstraction Layer
├── vfs/              # Virtual File System
│   └── models/       # File, Folder, Device, Proc
├── kernel/           # Kernel core
├── process/          # Process library (userland)
├── bin/              # Executable commands
└── lib/              # Shared libraries

spec/
├── hal/              # HAL tests
├── vfs/              # VFS tests
└── kernel/           # Kernel tests

planning/
└── OS_*.md           # Design documents
```
