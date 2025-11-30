# Monk OS Process Library

## Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| Syscall transport | ⏳ Pending | `src/process/syscall.ts` |
| Process API | ⏳ Pending | `src/process/index.ts` |
| Init process | ⏳ Pending | `src/bin/init.ts` |
| Boot test | ⏳ Pending | - |

---

## Philosophy

The process library is the **userland interface** to the kernel. It runs inside Bun Workers and provides typed functions that translate to syscall messages.

Processes don't know they're in a Worker. They just call `read()`, `write()`, `connect()` - the library handles the IPC.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Worker (Process)                                           │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  User Code                                              ││
│  │  import { open, read, write } from '@src/process'       ││
│  └─────────────────────────────────────────────────────────┘│
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  Process Library                                        ││
│  │  - syscall(name, ...args) → Promise<result>             ││
│  │  - Pending request map                                  ││
│  │  - Signal handlers                                      ││
│  └─────────────────────────────────────────────────────────┘│
│                           │                                 │
│                    postMessage / onmessage                  │
│                           │                                 │
├───────────────────────────┴─────────────────────────────────┤
│  Kernel (Main Thread)                                       │
│  - Kernel.handleMessage()                                   │
│  - SyscallDispatcher                                        │
└─────────────────────────────────────────────────────────────┘
```

## Syscall Transport

### Request Format

```typescript
interface SyscallRequest {
    type: 'syscall';
    id: string;        // UUID for correlation
    name: string;      // Syscall name
    args: unknown[];   // Arguments
}
```

### Response Format

```typescript
interface SyscallResponse {
    type: 'response';
    id: string;        // Matches request id
    result?: unknown;  // Success value
    error?: {
        code: string;  // Error code (ENOENT, EBADF, etc.)
        message: string;
    };
}
```

### Signal Format

```typescript
interface SignalMessage {
    type: 'signal';
    signal: number;    // SIGTERM (15), SIGKILL (9)
}
```

## Process Library API

### Core Syscall Function

```typescript
// Internal - not exported
const pending = new Map<string, { resolve: Function, reject: Function }>();

self.onmessage = (event: MessageEvent) => {
    const msg = event.data;

    if (msg.type === 'response') {
        const req = pending.get(msg.id);
        if (req) {
            pending.delete(msg.id);
            if (msg.error) {
                req.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
            } else {
                req.resolve(msg.result);
            }
        }
    } else if (msg.type === 'signal') {
        handleSignal(msg.signal);
    }
};

async function syscall<T>(name: string, ...args: unknown[]): Promise<T> {
    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        self.postMessage({ type: 'syscall', id, name, args });
    });
}
```

### Exported Functions

#### File Operations

```typescript
export function open(path: string, flags?: OpenFlags): Promise<number>;
export function close(fd: number): Promise<void>;
export function read(fd: number, size?: number): Promise<Uint8Array>;
export function write(fd: number, data: Uint8Array): Promise<number>;
export function seek(fd: number, offset: number, whence?: SeekWhence): Promise<number>;
export function stat(path: string): Promise<Stat>;
export function fstat(fd: number): Promise<Stat>;
export function mkdir(path: string): Promise<void>;
export function unlink(path: string): Promise<void>;
export function readdir(path: string): Promise<string[]>;
```

#### Network

```typescript
export function connect(proto: 'tcp', host: string, port: number): Promise<number>;
export function connect(proto: 'unix', path: string): Promise<number>;
```

#### Ports

```typescript
export function port(type: 'tcp:listen', opts: { port: number; host?: string }): Promise<number>;
export function port(type: 'udp', opts: { bind: number }): Promise<number>;
export function port(type: 'watch', opts: { pattern: string }): Promise<number>;
export function port(type: 'pubsub', opts: { subscribe: string[] }): Promise<number>;

export function recv(portId: number): Promise<PortMessage>;
export function send(portId: number, to: string, data: Uint8Array): Promise<void>;
export function pclose(portId: number): Promise<void>;
```

#### Process

```typescript
export function spawn(entry: string, opts?: SpawnOpts): Promise<number>;
export function exit(code: number): never;
export function kill(pid: number, signal?: number): Promise<void>;
export function wait(pid: number): Promise<ExitStatus>;
export function getpid(): Promise<number>;
export function getppid(): Promise<number>;
```

#### Environment

```typescript
export function getcwd(): Promise<string>;
export function chdir(path: string): Promise<void>;
export function getenv(name: string): Promise<string | undefined>;
export function setenv(name: string, value: string): Promise<void>;
```

## Signal Handling

Processes can register signal handlers:

```typescript
let signalHandler: ((signal: number) => void) | null = null;

export function onsignal(handler: (signal: number) => void): void {
    signalHandler = handler;
}

function handleSignal(signal: number): void {
    if (signalHandler) {
        signalHandler(signal);
    } else if (signal === SIGTERM) {
        // Default: exit gracefully
        exit(128 + signal);
    }
    // SIGKILL is never delivered - kernel terminates immediately
}
```

## Init Process

The init process (`/bin/init.ts`) is minimal:

```typescript
import { spawn, wait, exit, onsignal } from '@src/process';
import { SIGTERM } from '@src/process/constants';

async function main() {
    // Ignore SIGTERM (init can't be killed)
    onsignal(() => {});

    // Spawn shell on console
    const shellPid = await spawn('/bin/shell');

    // Reap children forever
    while (true) {
        try {
            await wait(-1); // Wait for any child
        } catch {
            // No children, sleep and retry
            await new Promise(r => setTimeout(r, 100));
        }
    }
}

main().catch(err => {
    console.error('init failed:', err);
    exit(1);
});
```

## Boot Sequence

1. Kernel creates init process (Worker)
2. Worker loads `/bin/init.ts`
3. Init's module-level code runs, sets up `onmessage`
4. Init calls `spawn('/bin/shell')` → syscall message
5. Kernel receives syscall, creates shell Worker
6. Kernel sends response with shell PID
7. Init receives response, continues

## Minimal Boot Test

For testing, a minimal process that just makes one syscall:

```typescript
// test/boot/echo.ts
import { getpid, exit } from '@src/process';

async function main() {
    const pid = await getpid();
    console.log(`Process ${pid} running`);
    exit(0);
}

main();
```

Test:
1. Kernel boots with `echo.ts` as init
2. `getpid()` syscall succeeds
3. `exit(0)` syscall terminates cleanly
4. Kernel sees zombie with exitCode 0

## Open Questions

1. **Console I/O** - How do stdout/stderr work? Currently mapped to console device UUIDs but no actual device. Need `/dev/console` or similar.

2. **Module resolution** - Worker entry points are file paths. How do imports resolve? Bun handles this, but paths like `/bin/init.ts` need to map to actual files.

3. **Error reconstruction** - When kernel sends error response, process library creates generic Error. Should we reconstruct typed errors (ENOENT, etc.)?

4. **Blocking semantics** - `recv()` blocks the async context but not the Worker. Is that sufficient, or do we need true blocking?
