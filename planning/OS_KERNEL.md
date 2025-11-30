# Monk OS Kernel Architecture

## Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| Kernel class | ✅ Done | `src/kernel/kernel.ts` |
| Process table | ✅ Done | `src/kernel/process-table.ts` |
| Syscall dispatch | ✅ Done | `src/kernel/syscalls.ts` |
| Types & errors | ✅ Done | `src/kernel/types.ts`, `errors.ts` |
| Scheduler | ⏳ Pending | - |
| Init process | ⏳ Pending | Requires Worker entry point |
| Network syscalls | ⏳ Pending | - |
| Port syscalls | ⏳ Pending | - |

---

## Philosophy

The Kernel is the central coordinator. It manages:

- **Processes** - creation, lifecycle, termination
- **VFS** - delegates file operations to VFS layer
- **Network** - TCP connections and Ports
- **Message Router** - connects Ports to event sources

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Processes (Workers)                                        │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │  init   │ │  httpd  │ │  shell  │ │  app    │           │
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

## Process Model

### Process = Worker

Processes are Bun Workers. This provides:

- **Isolation** - separate memory, can't corrupt kernel or other processes
- **Killable** - `worker.terminate()` stops it immediately
- **Message-based syscalls** - all kernel interaction via HAL IPCDevice

### Process Structure

```typescript
interface Process {
  /** Process UUID (internal identity) */
  id: string;

  /** Parent process UUID */
  parent: string;

  /** Bun Worker instance */
  worker: Worker;

  /** Current state */
  state: 'starting' | 'running' | 'stopped' | 'zombie';

  /** Entry point / command */
  cmd: string;

  /** Working directory */
  cwd: string;

  /** Environment variables */
  env: Record<string, string>;

  /** Open file descriptors: local fd → resource UUID */
  fds: Map<number, string>;

  /** Open ports: local port id → port UUID */
  ports: Map<number, string>;

  /** Next fd to allocate */
  nextFd: number;

  /** Next port id to allocate */
  nextPort: number;

  /** Exit code (when state = 'zombie') */
  exitCode?: number;
}
```

### File Descriptors

Processes use small integers for fds (POSIX-style ergonomics). The kernel maps these to UUIDs internally.

```typescript
// Process side (convenience)
const fd = await open('/etc/passwd');  // returns 3
await read(fd, 1024);

// Kernel side (reality)
proc.fds.set(3, '019d3f2a-...');  // maps 3 → resource UUID
```

The integer is a per-process handle. The UUID is the global resource identity.

### Standard Descriptors

New processes start with:

| fd | Resource |
|----|----------|
| 0 | stdin |
| 1 | stdout |
| 2 | stderr |

These are inherited from the parent or connected to `/dev/console` for init.

## Signals

Signals are minimal. Complex events use Ports instead.

| Signal | Value | Meaning |
|--------|-------|---------|
| SIGTERM | 15 | Graceful shutdown request |
| SIGKILL | 9 | Immediate termination (not catchable) |

### Signal Handling

Processes can opt-in to handle SIGTERM via a port:

```typescript
const signals = await port('signal', { catch: ['TERM'] });

for await (const msg of signals) {
  if (msg.data.signal === 'TERM') {
    await cleanup();
    await exit(0);
  }
}
```

If a process doesn't catch SIGTERM, it receives a grace period then SIGKILL.

SIGKILL is never catchable. The kernel terminates the worker immediately.

## Syscall Interface

### Transport

Syscalls travel through HAL IPCDevice, not raw `postMessage`. This allows the transport to be swapped (Bun Workers today, custom C runtime later).

```typescript
// HAL IPCDevice interface
interface IPCDevice {
  spawn(entry: string): ProcessHandle;
  send(proc: ProcessHandle, msg: Message): void;
  recv(proc: ProcessHandle): AsyncIterable<Message>;
  kill(proc: ProcessHandle): void;
}
```

### Syscall List

#### Process Management

| Syscall | Arguments | Returns | Description |
|---------|-----------|---------|-------------|
| `spawn` | entry, opts? | pid (number) | Create child process |
| `exit` | code | never | Terminate current process |
| `kill` | pid, signal? | void | Send signal to process |
| `wait` | pid | ExitStatus | Wait for child to exit |
| `getpid` | - | pid | Get current process id |
| `getppid` | - | pid | Get parent process id |

#### File Operations

| Syscall | Arguments | Returns | Description |
|---------|-----------|---------|-------------|
| `open` | path, flags | fd | Open file/device |
| `close` | fd | void | Close file descriptor |
| `read` | fd, size? | Uint8Array | Read from fd |
| `write` | fd, data | number | Write to fd, returns bytes written |
| `seek` | fd, offset, whence | number | Seek in file |
| `stat` | path | Stat | Get file metadata |
| `fstat` | fd | Stat | Get metadata from fd |
| `mkdir` | path | void | Create directory |
| `unlink` | path | void | Delete file |
| `rmdir` | path | void | Delete directory |
| `readdir` | path | string[] | List directory contents |
| `rename` | oldPath, newPath | void | Move/rename file |
| `access` | path, acl? | ACL | Read or set ACL |

#### Network

| Syscall | Arguments | Returns | Description |
|---------|-----------|---------|-------------|
| `connect` | proto, host, port | fd | TCP connect, returns stream fd |

#### Ports

| Syscall | Arguments | Returns | Description |
|---------|-----------|---------|-------------|
| `port` | type, opts | portId | Create port |
| `send` | portId, to, data | void | Send message on port |
| `recv` | portId | Message | Receive message (blocks) |
| `pclose` | portId | void | Close port |

#### Port Types

| Type | Options | Description |
|------|---------|-------------|
| `tcp:listen` | port, host?, backlog? | Accept TCP connections |
| `udp` | bind | Send/recv UDP datagrams |
| `watch` | pattern | File system events |
| `pubsub` | subscribe | Topic-based messaging |
| `signal` | catch | Catch signals (TERM) |
| `process` | watch | Child process events |

#### Miscellaneous

| Syscall | Arguments | Returns | Description |
|---------|-----------|---------|-------------|
| `getcwd` | - | string | Get working directory |
| `chdir` | path | void | Change working directory |
| `getenv` | name | string? | Get environment variable |
| `setenv` | name, value | void | Set environment variable |

### Syscall Dispatch

```typescript
class Kernel {
  async dispatch(proc: Process, name: string, args: unknown[]): Promise<unknown> {
    switch (name) {
      // Process
      case 'spawn': return this.spawn(proc, ...args);
      case 'exit': return this.exit(proc, ...args);
      case 'kill': return this.kill(proc, ...args);

      // VFS
      case 'open': return this.open(proc, ...args);
      case 'read': return this.read(proc, ...args);
      case 'write': return this.write(proc, ...args);
      // ...

      // Network
      case 'connect': return this.connect(proc, ...args);

      // Ports
      case 'port': return this.port(proc, ...args);
      case 'send': return this.send(proc, ...args);
      case 'recv': return this.recv(proc, ...args);

      default:
        throw new ENOSYS(name);
    }
  }
}
```

## Process Lifecycle

### Spawn

```typescript
async spawn(parent: Process, entry: string, opts?: SpawnOpts): Promise<number> {
  const proc: Process = {
    id: this.hal.entropy.uuid(),
    parent: parent.id,
    state: 'starting',
    cmd: entry,
    cwd: opts?.cwd ?? parent.cwd,
    env: { ...parent.env, ...opts?.env },
    fds: new Map(),
    ports: new Map(),
    nextFd: 3,  // 0,1,2 reserved for stdio
    nextPort: 0,
  };

  // Setup stdio
  this.setupStdio(proc, parent, opts);

  // Create worker via HAL
  proc.worker = this.hal.ipc.spawn(entry);

  // Wire up syscall handling
  this.hal.ipc.recv(proc.worker).then(async (messages) => {
    for await (const msg of messages) {
      this.handleSyscall(proc, msg);
    }
  });

  proc.state = 'running';

  // Register in process table
  this.processes.set(proc.id, proc);

  // Return local pid to parent
  return parent.nextPid++;
}
```

### Exit

```typescript
async exit(proc: Process, code: number): Promise<never> {
  proc.exitCode = code;
  proc.state = 'zombie';

  // Close all file descriptors
  for (const resourceId of proc.fds.values()) {
    const handle = this.handles.get(resourceId);
    await handle?.close();
  }

  // Close all ports
  for (const portId of proc.ports.values()) {
    const port = this.ports.get(portId);
    await port?.close();
  }

  // Terminate worker
  this.hal.ipc.kill(proc.worker);

  // Notify parent via 'process' port if they have one
  this.notifyParent(proc);

  // Never returns
  throw new ProcessExited(code);
}
```

### Kill

```typescript
kill(proc: Process, targetPid: number, signal: number = SIGTERM): void {
  const target = this.resolveProcess(proc, targetPid);

  if (signal === SIGKILL) {
    // Immediate termination
    this.forceExit(target, 128 + SIGKILL);
  } else if (signal === SIGTERM) {
    // Check if process catches SIGTERM
    const signalPort = this.findSignalPort(target);
    if (signalPort) {
      // Deliver via port
      this.deliverSignal(signalPort, 'TERM');
    } else {
      // Grace period then kill
      setTimeout(() => {
        if (target.state === 'running') {
          this.forceExit(target, 128 + SIGTERM);
        }
      }, TERM_GRACE_MS);
    }
  }
}
```

## Init Process

The first process (pid 1) is special:

- Started by kernel at boot
- Parent of orphaned processes
- Cannot be killed (SIGKILL is ignored)
- Minimal: just boots to a shell

### Minimal Init

```typescript
// /bin/init.ts

import { spawn, port } from '@monk/process';

async function main() {
  // Start a shell on console
  await spawn('/bin/shell');

  // Reap children forever
  const children = await port('process', { watch: 'children' });
  for await (const _ of children) {
    // zombie reaped
  }
}
```

That's it. Init spawns a shell and reaps zombies. No daemon management, no service config. Those are userland concerns to solve later.

### Kernel Boot Sequence

```typescript
class Kernel {
  async boot(): Promise<void> {
    // Create init process
    const init: Process = {
      id: this.hal.entropy.uuid(),
      parent: '',  // no parent
      state: 'starting',
      cmd: '/bin/init',
      cwd: '/',
      env: this.bootEnv,
      fds: new Map(),
      ports: new Map(),
      nextFd: 3,
      nextPort: 0,
    };

    // Connect stdio to console
    init.fds.set(0, this.consoleStdin);
    init.fds.set(1, this.consoleStdout);
    init.fds.set(2, this.consoleStderr);

    // Start init
    init.worker = this.hal.ipc.spawn('/bin/init');
    init.state = 'running';

    this.processes.set(init.id, init);
    this.initProcess = init;
  }
}
```

### Boot Result

After boot completes:

1. Kernel running
2. VFS available
3. Network available (HAL ready)
4. Console shell session active

Everything else (daemons, services, config management) is userland.

## Process Library

Processes import a library that wraps syscalls:

```typescript
// /lib/process.ts

async function syscall<T>(name: string, ...args: unknown[]): Promise<T> {
  const id = crypto.randomUUID();

  // Send via HAL IPC (abstracted, not raw postMessage)
  ipc.send({ type: 'syscall', id, name, args });

  // Wait for response
  return ipc.waitResponse(id);
}

// File operations
export const open = (path: string, flags: number) => syscall<number>('open', path, flags);
export const close = (fd: number) => syscall<void>('close', fd);
export const read = (fd: number, size?: number) => syscall<Uint8Array>('read', fd, size);
export const write = (fd: number, data: Uint8Array) => syscall<number>('write', fd, data);
export const stat = (path: string) => syscall<Stat>('stat', path);

// Network
export const connect = (proto: string, host: string, port: number) =>
  syscall<number>('connect', proto, host, port);

// Ports
export const port = (type: string, opts: object) => syscall<number>('port', type, opts);
export const send = (portId: number, to: string, data: Uint8Array) =>
  syscall<void>('send', portId, to, data);
export const recv = (portId: number) => syscall<Message>('recv', portId);

// Process
export const spawn = (entry: string, opts?: SpawnOpts) => syscall<number>('spawn', entry, opts);
export const exit = (code: number) => syscall<never>('exit', code);
export const kill = (pid: number, signal?: number) => syscall<void>('kill', pid, signal);

// Convenience: async iterator for port
export async function* messages(portId: number): AsyncIterable<Message> {
  while (true) {
    yield await recv(portId);
  }
}
```

## Message Router

The kernel routes events to ports:

```
┌─────────────────────────────────────────────────────────────┐
│  Event Sources                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │   VFS    │ │ Network  │ │  PubSub  │ │ Process  │       │
│  │  writes  │ │  accept  │ │ publish  │ │  events  │       │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘       │
│       │            │            │            │              │
│       └────────────┴────────────┴────────────┘              │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                   Message Router                        ││
│  │                                                         ││
│  │  watch:/users/*     → [port-abc, port-def]             ││
│  │  pubsub:orders.*    → [port-ghi]                       ││
│  │  tcp:listen:8080    → [port-jkl]                       ││
│  │  process:children   → [port-mno]                       ││
│  │                                                         ││
│  └─────────────────────────────────────────────────────────┘│
│                           │                                 │
│       ┌───────────────────┼───────────────────┐            │
│       ▼                   ▼                   ▼            │
│  ┌─────────┐         ┌─────────┐         ┌─────────┐       │
│  │ Process │         │ Process │         │ Process │       │
│  │    A    │         │    B    │         │    C    │       │
│  └─────────┘         └─────────┘         └─────────┘       │
└─────────────────────────────────────────────────────────────┘
```

When a process calls `recv(portId)`, it blocks until the router delivers a message to that port.

## Capabilities (Future)

Process permissions are tracked per-process. A process can only:

- Open files it has access to (via VFS ACLs)
- Create ports it has capability for
- Send signals to processes it owns

Capabilities are inherited from parent and can be dropped but not gained.

```typescript
interface Process {
  // ... other fields

  /** Capability set */
  caps: Set<string>;
  // 'net.listen:*'     - can listen on any port
  // 'net.listen:8080'  - can listen on port 8080
  // 'net.connect'      - can make outbound connections
  // 'vfs.read:/home/*' - can read under /home
  // 'proc.signal:*'    - can signal any process
}
```

Detailed capability design TBD.

## Future: GUI Support

The architecture supports future GUI by:

1. **HAL is extensible** - can add DisplayDevice, InputDevice
2. **Ports handle events** - input, window events will be port types
3. **Surfaces aren't files** - like network, dedicated syscalls when needed
4. **Shared memory** - HAL IPCDevice can support mmap-style framebuffers

No specific GUI syscalls are designed yet.

## Process Table Persistence

The kernel's process table is **runtime-only, in-memory**. Processes do not survive kernel restart.

On shutdown:
- All processes receive SIGTERM
- After grace period, remaining processes receive SIGKILL
- Process table is discarded

On boot:
- Init starts fresh
- Init reads daemon config from VFS (`/etc/daemons.d/`, etc.)
- Init spawns configured services

**Rationale:** Serializing process state is complex (Workers can't be serialized, network connections are lost, file positions reset). Daemons should be designed to restart cleanly from config. If checkpoint/restore is needed later, the architecture allows adding it via `/sys/kernel/checkpoint`.

---

## Open Questions

1. **Process entry points** - How are process scripts located? `/bin/`, VFS paths, or bundled?

2. **Stdio inheritance** - Should children inherit parent's stdio fds, or get new pipes?

3. **Resource limits** - Memory limits, fd limits, cpu time per process?

4. **Orphan reparenting** - When a process dies, do its children get reparented to init?

5. **Process groups** - Do we need process groups for job control?
