# OS Syscall Layer - Architecture & Implementation Plan

## Implementation Status

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | Create `src/syscall/` structure | **COMPLETE** |
| Phase 2 | Integrate with Kernel | **COMPLETE** |
| Phase 3 | Migrate Syscalls | **COMPLETE** |
| Phase 4 | Cleanup | **COMPLETE** |

### Phase 1 Completion Details (2024-12-07)

All files created and TypeScript compilation verified:

```
src/syscall/
├── stream/
│   ├── constants.ts     ✓
│   ├── types.ts         ✓
│   ├── controller.ts    ✓
│   └── index.ts         ✓
├── types.ts             ✓
├── vfs.ts               ✓
├── process.ts           ✓
├── ems.ts               ✓
├── hal.ts               ✓
├── handle.ts            ✓
├── pool.ts              ✓
├── dispatcher.ts        ✓
└── index.ts             ✓
```

Key implementation notes:
- Stream module copied from `src/router/stream/` with updated module paths
- All syscall functions follow the direct dependency pattern from the plan
- Dispatcher uses switch-based routing as specified
- TypeScript compiles without errors

### Phase 2-4 Completion Details (2024-12-07)

The syscall layer has been fully integrated with the kernel. Key architectural changes:

1. **Dispatcher sits outside kernel**: The `SyscallDispatcher` is created by the OS layer
   and receives `(kernel, vfs, ems, hal)` as constructor dependencies. The kernel does NOT
   reference the dispatcher.

2. **Kernel provides message callback**: The kernel exposes `onWorkerMessage` callback
   that is set by the OS after creating the dispatcher. When workers spawn, they route
   messages through this callback to the dispatcher.

3. **Message flow**:
   ```
   Worker → kernel.onWorkerMessage → dispatcher.handleMessage()
                                          ↓
                                    dispatcher.execute()
                                          ↓
                                    dispatcher.dispatch()
                                          ↓
                                    syscall handlers
   ```

4. **Deleted files**:
   - `src/kernel/syscalls/` directory (old dispatcher and syscall creators)
   - `src/kernel/syscalls.ts` (re-export file)
   - `src/kernel/kernel/process-message.ts` (message routing now in dispatcher)
   - `src/kernel/kernel/dispatch-syscall.ts` (streaming now in dispatcher)
   - `src/kernel/kernel/on-stream-ping.ts` (handled by dispatcher)
   - `src/kernel/kernel/on-stream-cancel.ts` (handled by dispatcher)
   - `src/kernel/kernel/send-response.ts` (inlined in dispatcher)
   - `src/router/` directory (superseded by src/syscall/)

5. **Moved types**:
   - `ProcessPortMessage` moved from `src/kernel/syscalls/types.ts` to `src/kernel/types.ts`

---

## Overview

This document describes the introduction of a dedicated `src/syscall/` layer that separates system call routing and implementation from the kernel. The kernel will be minimized to focus solely on **process management** and **handle management**, while syscalls become an orchestration layer that routes to kernel, VFS, EMS, and HAL as needed.

## Motivation

### Current State Problems

1. **Kernel does too much**: The kernel currently owns syscall implementations, handle management, process management, service activation, worker pools, and more. This makes it hard to reason about, test, and maintain.

2. **Unclear boundaries**: Syscalls that only touch VFS (like `file:stat`) still route through kernel code. Syscalls that only touch EMS (like `ems:select`) live alongside process syscalls.

3. **Disconnected router**: `src/router/` was an attempt at separation but is unused. It defines a `KernelOps` interface that nothing implements.

4. **Testing friction**: Syscalls need the full kernel to test, even when they only need VFS or EMS.

### Design Principles

1. **Kernel is a process manager**: If userspace didn't exist, the kernel would only manage processes and their handles. Everything else is passthrough.

2. **Syscalls are orchestration**: A syscall like `file:open` needs both VFS (to open the file) and kernel (to assign the handle). The syscall layer orchestrates these.

3. **Direct dependencies**: Each syscall function receives exactly what it needs (kernel, vfs, proc, etc.) as parameters—no context objects.

4. **Yield errors, don't throw**: All syscalls return `AsyncIterable<Response>`. Validation errors are yielded, not thrown.

---

## Target Architecture

### Directory Structure

```
src/syscall/
├── index.ts           # Exports SyscallDispatcher
├── dispatcher.ts      # Switch-based routing, StreamController wrapping
├── stream/            # Backpressure protocol (moved from router/)
│   ├── index.ts
│   ├── controller.ts
│   ├── constants.ts
│   └── types.ts
├── vfs.ts             # file:* syscalls → VFS + Kernel (for handles)
├── ems.ts             # ems:* syscalls → EMS
├── hal.ts             # net:*, channel:* syscalls → HAL + Kernel
├── process.ts         # proc:* syscalls → Kernel
├── handle.ts          # handle:*, ipc:* syscalls → Kernel
├── pool.ts            # pool:*, worker:* syscalls → Kernel
└── types.ts           # Shared types (Process context, etc.)
```

### Layer Responsibilities

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Syscall Layer (src/syscall/)                                               │
│  - Argument validation (yield errors, don't throw)                          │
│  - Streaming/backpressure protocol                                          │
│  - Routes to: Kernel, VFS, EMS, HAL                                         │
│  - Orchestrates multi-subsystem operations                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  Kernel (src/kernel/)                                                       │
│  - Process table (spawn, exit, kill, wait, signals)                         │
│  - Handle table (assign, get, close, reference counting)                    │
│  - Worker management (pools, activation)                                    │
│  - Service activation (boot, tcp, udp, pubsub, watch)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  VFS              │  EMS              │  HAL                                │
│  - Path namespace │  - Entity CRUD    │  - Network devices                  │
│  - File models    │  - Observers      │  - Channels                         │
│  - Mounts         │  - Caching        │  - Storage engines                  │
└───────────────────┴───────────────────┴─────────────────────────────────────┘
```

---

## Syscall Dispatcher Design

### Core Structure

```typescript
// src/syscall/dispatcher.ts

import type { Response } from '../message.js';
import type { Process } from '../kernel/types.js';
import type { Kernel } from '../kernel/kernel.js';
import type { VFS } from '../vfs/index.js';
import type { EMS } from '../ems/ems.js';
import type { HAL } from '../hal/index.js';
import { respond } from '../message.js';
import { StreamController, StallError } from './stream/index.js';

// VFS syscalls
import { fileOpen, fileClose, fileRead, fileWrite, fileSeek } from './vfs.js';
import { fileStat, fileFstat, fileMkdir, fileUnlink, fileRmdir } from './vfs.js';
import { fileReaddir, fileRename, fileSymlink, fileAccess } from './vfs.js';
import { fileRecv, fileSend } from './vfs.js';

// Process syscalls
import { procSpawn, procExit, procKill, procWait } from './process.js';
import { procGetpid, procGetppid, procCreate } from './process.js';
import { procGetargs, procGetcwd, procChdir, procGetenv, procSetenv } from './process.js';

// EMS syscalls
import { emsSelect, emsCreate, emsUpdate, emsDelete, emsRevert, emsExpire } from './ems.js';

// HAL syscalls (network, channel)
import { netConnect } from './hal.js';
import { portCreate, portClose, portRecv, portSend } from './hal.js';
import { channelOpen, channelClose, channelCall, channelStream } from './hal.js';
import { channelPush, channelRecv } from './hal.js';

// Handle/IPC syscalls
import { handleRedirect, handleRestore, handleSend, handleClose } from './handle.js';
import { ipcPipe } from './handle.js';

// Pool/worker syscalls
import { poolLease, poolStats, workerLoad, workerSend, workerRecv, workerRelease } from './pool.js';

// Mount syscalls
import { fsMount, fsUmount } from './vfs.js';

// Service activation
import { activationGet } from './process.js';

export class SyscallDispatcher {
    constructor(
        private readonly kernel: Kernel,
        private readonly vfs: VFS,
        private readonly ems: EMS | undefined,
        private readonly hal: HAL,
    ) {}

    /**
     * Dispatch a syscall from a process.
     *
     * DESIGN:
     * - Switch statement routes by syscall name
     * - Args are spread directly to syscall functions
     * - Each syscall validates its own arguments
     * - All syscalls yield errors, never throw
     */
    async *dispatch(proc: Process, name: string, args: unknown[]): AsyncIterable<Response> {
        switch (name) {
            // =================================================================
            // VFS SYSCALLS (file:*)
            // =================================================================

            case 'file:open':
                yield* fileOpen(proc, this.kernel, this.vfs, ...args);
                break;

            case 'file:close':
                yield* fileClose(proc, this.kernel, ...args);
                break;

            case 'file:read':
                yield* fileRead(proc, this.kernel, ...args);
                break;

            case 'file:write':
                yield* fileWrite(proc, this.kernel, ...args);
                break;

            case 'file:seek':
                yield* fileSeek(proc, this.kernel, ...args);
                break;

            case 'file:stat':
                yield* fileStat(proc, this.vfs, ...args);
                break;

            case 'file:fstat':
                yield* fileFstat(proc, this.kernel, this.vfs, ...args);
                break;

            case 'file:mkdir':
                yield* fileMkdir(proc, this.vfs, ...args);
                break;

            case 'file:unlink':
                yield* fileUnlink(proc, this.vfs, ...args);
                break;

            case 'file:rmdir':
                yield* fileRmdir(proc, this.vfs, ...args);
                break;

            case 'file:readdir':
                yield* fileReaddir(proc, this.vfs, ...args);
                break;

            case 'file:rename':
                yield* fileRename(proc, this.vfs, ...args);
                break;

            case 'file:symlink':
                yield* fileSymlink(proc, this.vfs, ...args);
                break;

            case 'file:access':
                yield* fileAccess(proc, this.vfs, ...args);
                break;

            case 'file:recv':
                yield* fileRecv(proc, this.kernel, ...args);
                break;

            case 'file:send':
                yield* fileSend(proc, this.kernel, ...args);
                break;

            // =================================================================
            // MOUNT SYSCALLS (fs:*)
            // =================================================================

            case 'fs:mount':
                yield* fsMount(proc, this.kernel, this.vfs, ...args);
                break;

            case 'fs:umount':
                yield* fsUmount(proc, this.kernel, this.vfs, ...args);
                break;

            // =================================================================
            // PROCESS SYSCALLS (proc:*)
            // =================================================================

            case 'proc:spawn':
                yield* procSpawn(proc, this.kernel, ...args);
                break;

            case 'proc:exit':
                yield* procExit(proc, this.kernel, ...args);
                break;

            case 'proc:kill':
                yield* procKill(proc, this.kernel, ...args);
                break;

            case 'proc:wait':
                yield* procWait(proc, this.kernel, ...args);
                break;

            case 'proc:getpid':
                yield* procGetpid(proc, this.kernel);
                break;

            case 'proc:getppid':
                yield* procGetppid(proc, this.kernel);
                break;

            case 'proc:create':
                yield* procCreate(proc, this.kernel, ...args);
                break;

            case 'proc:getargs':
                yield* procGetargs(proc);
                break;

            case 'proc:getcwd':
                yield* procGetcwd(proc);
                break;

            case 'proc:chdir':
                yield* procChdir(proc, this.vfs, ...args);
                break;

            case 'proc:getenv':
                yield* procGetenv(proc, ...args);
                break;

            case 'proc:setenv':
                yield* procSetenv(proc, ...args);
                break;

            // =================================================================
            // EMS SYSCALLS (ems:*)
            // =================================================================

            case 'ems:select':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsSelect(proc, this.ems, ...args);
                break;

            case 'ems:create':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsCreate(proc, this.ems, ...args);
                break;

            case 'ems:update':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsUpdate(proc, this.ems, ...args);
                break;

            case 'ems:delete':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsDelete(proc, this.ems, ...args);
                break;

            case 'ems:revert':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsRevert(proc, this.ems, ...args);
                break;

            case 'ems:expire':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsExpire(proc, this.ems, ...args);
                break;

            // =================================================================
            // NETWORK SYSCALLS (net:*, port:*)
            // =================================================================

            case 'net:connect':
                yield* netConnect(proc, this.kernel, this.hal, ...args);
                break;

            case 'port:create':
                yield* portCreate(proc, this.kernel, ...args);
                break;

            case 'port:close':
                yield* portClose(proc, this.kernel, ...args);
                break;

            case 'port:recv':
                yield* portRecv(proc, this.kernel, ...args);
                break;

            case 'port:send':
                yield* portSend(proc, this.kernel, ...args);
                break;

            // =================================================================
            // CHANNEL SYSCALLS (channel:*)
            // =================================================================

            case 'channel:open':
                yield* channelOpen(proc, this.kernel, this.hal, ...args);
                break;

            case 'channel:close':
                yield* channelClose(proc, this.kernel, ...args);
                break;

            case 'channel:call':
                yield* channelCall(proc, this.kernel, ...args);
                break;

            case 'channel:stream':
                yield* channelStream(proc, this.kernel, ...args);
                break;

            case 'channel:push':
                yield* channelPush(proc, this.kernel, ...args);
                break;

            case 'channel:recv':
                yield* channelRecv(proc, this.kernel, ...args);
                break;

            // =================================================================
            // HANDLE/IPC SYSCALLS (handle:*, ipc:*)
            // =================================================================

            case 'handle:redirect':
                yield* handleRedirect(proc, this.kernel, ...args);
                break;

            case 'handle:restore':
                yield* handleRestore(proc, this.kernel, ...args);
                break;

            case 'handle:send':
                yield* handleSend(proc, this.kernel, ...args);
                break;

            case 'handle:close':
                yield* handleClose(proc, this.kernel, ...args);
                break;

            case 'ipc:pipe':
                yield* ipcPipe(proc, this.kernel);
                break;

            // =================================================================
            // WORKER POOL SYSCALLS (pool:*, worker:*)
            // =================================================================

            case 'pool:lease':
                yield* poolLease(proc, this.kernel, ...args);
                break;

            case 'pool:stats':
                // Exception: pool:stats doesn't need proc
                yield* poolStats(this.kernel);
                break;

            case 'worker:load':
                yield* workerLoad(proc, this.kernel, ...args);
                break;

            case 'worker:send':
                yield* workerSend(proc, this.kernel, ...args);
                break;

            case 'worker:recv':
                yield* workerRecv(proc, this.kernel, ...args);
                break;

            case 'worker:release':
                yield* workerRelease(proc, this.kernel, ...args);
                break;

            // =================================================================
            // SERVICE ACTIVATION
            // =================================================================

            case 'activation:get':
                yield* activationGet(proc);
                break;

            // =================================================================
            // UNKNOWN SYSCALL
            // =================================================================

            default:
                yield respond.error('ENOSYS', `Unknown syscall: ${name}`);
        }
    }
}
```

---

## Syscall Function Signatures

### Pattern

Each syscall is a standalone async generator function that:
1. Receives dependencies in consistent order (see below)
2. Receives syscall-specific arguments as `unknown` types
3. Validates arguments and yields errors (never throws)
4. Returns `AsyncIterable<Response>`

**Argument order (omit what's not needed):**
1. `proc` - Process context (nearly all syscalls need this)
2. `kernel` - For handle/process operations
3. `vfs` - For filesystem operations
4. `ems` - For entity operations
5. `hal` - For network/channel operations
6. Syscall-specific args (`path`, `fd`, `flags`, etc.)

**Syscalls that don't need `proc`:**
- `pool:stats` - Just returns pool statistics (only needs `kernel`)

**Syscalls that only need `proc` (no kernel/vfs/ems/hal):**
- `proc:getargs` - Returns `proc.args`
- `proc:getcwd` - Returns `proc.cwd`
- `proc:getenv` - Returns `proc.env[name]`
- `proc:setenv` - Sets `proc.env[name] = value`
- `activation:get` - Returns `proc.activationMessage`

### Example: VFS Syscalls

```typescript
// src/syscall/vfs.ts

import type { Kernel } from '../kernel/kernel.js';
import type { VFS } from '../vfs/index.js';
import type { Process, OpenFlags } from '../kernel/types.js';
import type { Response } from '../message.js';
import { respond } from '../message.js';
import { MAX_STREAM_ENTRIES } from '../kernel/types.js';

// =============================================================================
// FILE DESCRIPTOR OPERATIONS
// =============================================================================

/**
 * Open a file and allocate a file descriptor.
 *
 * This syscall needs both VFS (to open the file) and Kernel (to assign the handle).
 */
export async function* fileOpen(
    proc: Process,
    kernel: Kernel,
    vfs: VFS,
    path: unknown,
    flags?: unknown,
): AsyncIterable<Response> {
    // Validate path
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    // Parse flags with read-only default
    const openFlags: OpenFlags = typeof flags === 'object' && flags !== null
        ? flags as OpenFlags
        : { read: true };

    // Open file via VFS
    const handle = await vfs.open(path, proc.user, openFlags);

    // Assign handle to process via Kernel
    const fd = kernel.assignHandle(proc, handle);

    yield respond.ok(fd);
}

/**
 * Close a file descriptor.
 *
 * Only needs Kernel—handle management is kernel's domain.
 */
export async function* fileClose(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');
        return;
    }

    await kernel.closeHandle(proc, fd);
    yield respond.ok();
}

/**
 * Read from a file descriptor.
 *
 * Only needs Kernel—get handle and delegate to it.
 */
export async function* fileRead(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
    chunkSize?: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');
        return;
    }

    const handle = kernel.getHandle(proc, fd);
    if (!handle) {
        yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
        return;
    }

    // Delegate to handle's recv implementation
    yield* handle.exec({ op: 'recv', data: { chunkSize } });
}

/**
 * Get file stats by path.
 *
 * Only needs VFS—no handle involved.
 */
export async function* fileStat(
    proc: Process,
    vfs: VFS,
    path: unknown,
): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    const stat = await vfs.stat(path, proc.user);
    yield respond.ok(stat);
}

/**
 * List directory contents (streaming).
 *
 * Only needs VFS. Yields items one at a time, then done.
 */
export async function* fileReaddir(
    proc: Process,
    vfs: VFS,
    path: unknown,
): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    let count = 0;

    try {
        for await (const entry of vfs.readdir(path, proc.user)) {
            count++;
            if (count > MAX_STREAM_ENTRIES) {
                yield respond.error('EFBIG', `Directory listing exceeded ${MAX_STREAM_ENTRIES} entries`);
                return;
            }
            yield respond.item(entry.name);
        }
        yield respond.done();
    }
    catch (err) {
        yield respond.error('ENOENT', (err as Error).message);
    }
}
```

### Example: Process Syscalls

```typescript
// src/syscall/process.ts

import type { Kernel } from '../kernel/kernel.js';
import type { VFS } from '../vfs/index.js';
import type { Process, SpawnOpts } from '../kernel/types.js';
import type { Response } from '../message.js';
import { respond } from '../message.js';

/**
 * Spawn a child process.
 */
export async function* procSpawn(
    proc: Process,
    kernel: Kernel,
    entry: unknown,
    opts?: unknown,
): AsyncIterable<Response> {
    if (typeof entry !== 'string') {
        yield respond.error('EINVAL', 'entry must be a string');
        return;
    }

    const pid = await kernel.spawn(proc, entry, opts as SpawnOpts);
    yield respond.ok(pid);
}

/**
 * Exit the calling process.
 */
export async function* procExit(
    proc: Process,
    kernel: Kernel,
    code: unknown,
): AsyncIterable<Response> {
    if (typeof code !== 'number' || code < 0) {
        yield respond.error('EINVAL', 'code must be a non-negative number');
        return;
    }

    await kernel.exit(proc, code);
    yield respond.ok();
}

/**
 * Get process arguments.
 *
 * Only needs Process—no kernel access needed.
 */
export async function* procGetargs(
    proc: Process,
): AsyncIterable<Response> {
    yield respond.ok(proc.args);
}

// =============================================================================
// POOL SYSCALLS (example of syscall that doesn't need proc)
// =============================================================================

/**
 * Get pool statistics.
 *
 * Doesn't need proc at all—just queries kernel state.
 */
export async function* poolStats(
    kernel: Kernel,
): AsyncIterable<Response> {
    yield respond.ok(kernel.poolStats());
}

/**
 * Get current working directory.
 */
export async function* procGetcwd(
    proc: Process,
): AsyncIterable<Response> {
    yield respond.ok(proc.cwd);
}

/**
 * Change working directory.
 *
 * Needs VFS to validate path, then mutates process state.
 */
export async function* procChdir(
    proc: Process,
    vfs: VFS,
    path: unknown,
): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    // Resolve relative path
    const resolved = resolvePath(proc.cwd, path);

    // Validate directory exists
    try {
        const stat = await vfs.stat(resolved, proc.user);
        if (stat.model !== 'folder') {
            yield respond.error('ENOTDIR', `Not a directory: ${path}`);
            return;
        }
    }
    catch (err) {
        const code = (err as { code?: string }).code ?? 'ENOENT';
        yield respond.error(code, (err as Error).message);
        return;
    }

    // Update process cwd
    proc.cwd = resolved;
    yield respond.ok();
}
```

---

## Minimized Kernel Interface

After refactoring, the kernel exposes a minimal interface focused on process and handle management:

```typescript
// src/kernel/kernel.ts (minimized interface)

export class Kernel {
    // =========================================================================
    // PROCESS LIFECYCLE
    // =========================================================================

    /**
     * Spawn a child process.
     */
    spawn(parent: Process, entry: string, opts?: SpawnOpts): Promise<number>;

    /**
     * Exit a process.
     */
    exit(proc: Process, code: number): Promise<void>;

    /**
     * Send signal to a process.
     */
    kill(proc: Process, targetPid: number, signal?: number): Promise<void>;

    /**
     * Wait for a child process to exit.
     */
    wait(proc: Process, targetPid: number, timeout?: number): Promise<ExitStatus>;

    /**
     * Get process PID in parent's namespace.
     */
    getpid(proc: Process): number;

    /**
     * Get parent process PID.
     */
    getppid(proc: Process): number;

    /**
     * Create a virtual process (for gatewayd).
     */
    createVirtualProcess(
        parent: Process,
        opts?: { cwd?: string; env?: Record<string, string> },
    ): Promise<{ pid: number; id: string }>;

    // =========================================================================
    // HANDLE MANAGEMENT
    // =========================================================================

    /**
     * Assign a handle to a process, returning the allocated fd.
     */
    assignHandle(proc: Process, handle: Handle): number;

    /**
     * Get a handle by fd.
     */
    getHandle(proc: Process, fd: number): Handle | undefined;

    /**
     * Close a handle by fd (with reference counting).
     */
    closeHandle(proc: Process, fd: number): Promise<void>;

    // =========================================================================
    // PORT MANAGEMENT (Kernel-owned because ports produce handles)
    // =========================================================================

    /**
     * Create a port (tcp:listen, udp, watch, pubsub).
     */
    createPort(proc: Process, type: string, opts: unknown): Promise<number>;

    /**
     * Get port from handle.
     */
    getPort(proc: Process, fd: number): Port | undefined;

    /**
     * Receive from port (auto-allocates handles for incoming connections).
     */
    recvPort(proc: Process, fd: number): Promise<ProcessPortMessage>;

    // =========================================================================
    // CHANNEL MANAGEMENT (Similar to ports—produces handles)
    // =========================================================================

    /**
     * Open a channel.
     */
    openChannel(proc: Process, proto: string, url: string, opts?: ChannelOpts): Promise<number>;

    /**
     * Get channel from handle.
     */
    getChannel(proc: Process, fd: number): Channel | undefined;

    // =========================================================================
    // NETWORK (TCP connects produce handles)
    // =========================================================================

    /**
     * Connect TCP and allocate socket handle.
     */
    connectTcp(proc: Process, host: string, port: number): Promise<number>;

    // =========================================================================
    // IPC
    // =========================================================================

    /**
     * Create a pipe (returns [readFd, writeFd]).
     */
    createPipe(proc: Process): Promise<[number, number]>;

    /**
     * Redirect a handle.
     */
    redirectHandle(proc: Process, target: number, source: number): Promise<string>;

    /**
     * Restore a handle.
     */
    restoreHandle(proc: Process, target: number, saved: string): Promise<void>;

    // =========================================================================
    // WORKER POOLS
    // =========================================================================

    /**
     * Lease a worker from a pool.
     */
    leaseWorker(proc: Process, pool?: string): Promise<string>;

    /**
     * Load script into leased worker.
     */
    workerLoad(proc: Process, workerId: string, path: string): Promise<void>;

    /**
     * Send message to leased worker.
     */
    workerSend(proc: Process, workerId: string, msg: unknown): Promise<void>;

    /**
     * Receive from leased worker.
     */
    workerRecv(proc: Process, workerId: string): Promise<unknown>;

    /**
     * Release worker back to pool.
     */
    workerRelease(proc: Process, workerId: string): Promise<void>;

    /**
     * Get pool statistics.
     */
    poolStats(): PoolStats[];

    // =========================================================================
    // MOUNT POLICY (Kernel enforces policy, VFS does actual mount)
    // =========================================================================

    /**
     * Check mount policy and perform mount.
     */
    mount(proc: Process, source: string, target: string, opts?: Record<string, unknown>): Promise<void>;

    /**
     * Check mount policy and perform unmount.
     */
    umount(proc: Process, target: string): Promise<void>;

    // =========================================================================
    // PROCESS QUERIES
    // =========================================================================

    /**
     * Get process by UUID.
     */
    getProcess(id: string): Process | undefined;

    /**
     * Get process by PID (in parent's namespace).
     */
    getProcessByPid(parent: Process, pid: number): Process | undefined;
}
```

---

## Streaming and Backpressure

The `StreamController` from `src/router/stream/` is moved to `src/syscall/stream/`. The dispatcher uses it to wrap syscall execution:

```typescript
// src/syscall/dispatcher.ts (execute method)

/**
 * Execute a syscall with streaming and backpressure.
 *
 * This wraps dispatch() with StreamController for backpressure management.
 * Called by the kernel's message handler.
 */
async *execute(
    proc: Process,
    requestId: string,
    name: string,
    args: unknown[],
): AsyncIterable<Response> {
    const controller = new StreamController(this.deps);

    // Register for ping/cancel
    this.registerStream(proc.id, requestId, controller);

    try {
        const source = this.dispatch(proc, name, args);

        for await (const response of controller.wrap(source)) {
            // Check process state after each await
            if (proc.state === 'zombie') {
                break;
            }

            yield response;

            // Terminal ops end stream
            if (response.op === 'ok' || response.op === 'error' ||
                response.op === 'done' || response.op === 'redirect') {
                return;
            }
        }
    }
    catch (err) {
        if (err instanceof StallError) {
            yield respond.error('ETIMEDOUT', err.message);
            return;
        }

        const error = err as Error & { code?: string };
        yield respond.error(error.code ?? 'EIO', error.message);
    }
    finally {
        this.unregisterStream(proc.id, requestId);
    }
}
```

---

## Migration Plan

### Phase 1: Create `src/syscall/` Structure [COMPLETE]

1. Create directory structure:
   ```
   src/syscall/
   ├── index.ts
   ├── dispatcher.ts
   ├── stream/
   │   ├── index.ts
   │   ├── controller.ts
   │   ├── constants.ts
   │   └── types.ts
   ├── vfs.ts
   ├── ems.ts
   ├── hal.ts
   ├── process.ts
   ├── handle.ts
   ├── pool.ts
   └── types.ts
   ```

2. Move `src/router/stream/` to `src/syscall/stream/`

3. Implement syscall functions in each domain file

4. Implement `SyscallDispatcher` with switch-based routing

### Phase 2: Integrate with Kernel [NOT STARTED]

1. Add `SyscallDispatcher` to kernel construction

2. Modify kernel's message handler to use `dispatcher.execute()`

3. Update kernel to expose minimized interface methods

4. Keep existing `src/kernel/syscalls/` working (dual-path)

### Phase 3: Migrate Syscalls [NOT STARTED]

For each syscall domain:

1. Implement in `src/syscall/` (new location)
2. Verify with existing tests
3. Remove from `src/kernel/syscalls/` (old location)
4. Ensure tests still pass

Order:
1. `vfs.ts` - Largest, most syscalls
2. `process.ts` - Core process operations
3. `ems.ts` - Already well-isolated
4. `hal.ts` - Network and channel
5. `handle.ts` - Handle manipulation
6. `pool.ts` - Worker pools

### Phase 4: Cleanup [NOT STARTED]

1. Delete `src/kernel/syscalls/` directory
2. Delete `src/router/` directory
3. Update exports in `src/kernel/index.ts`
4. Update AGENTS.md architecture diagram

---

## Testing Strategy

### Unit Tests for Syscalls

Each syscall can be tested in isolation with mocked dependencies:

```typescript
// spec/syscall/vfs.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fileOpen, fileStat, fileReaddir } from '../../src/syscall/vfs.js';
import { collect } from '../helpers.js';

describe('fileOpen', () => {
    it('returns fd for opened file', async () => {
        const mockHandle = { id: 'h1', type: 'file' };
        const mockKernel = {
            assignHandle: vi.fn().mockReturnValue(3),
        };
        const mockVfs = {
            open: vi.fn().mockResolvedValue(mockHandle),
        };
        const mockProc = { user: 'test', cwd: '/' };

        const results = await collect(fileOpen(mockProc, mockKernel, mockVfs, '/test.txt'));

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({ op: 'ok', data: 3 });
        expect(mockVfs.open).toHaveBeenCalledWith('/test.txt', 'test', { read: true });
        expect(mockKernel.assignHandle).toHaveBeenCalledWith(mockProc, mockHandle);
    });

    it('yields EINVAL for non-string path', async () => {
        const mockProc = { user: 'test' };
        const results = await collect(fileOpen(mockProc, {}, {}, 123));

        expect(results).toHaveLength(1);
        expect(results[0].op).toBe('error');
        expect(results[0].data.code).toBe('EINVAL');
    });
});

describe('fileStat', () => {
    it('returns stat object', async () => {
        const mockStat = { id: 'x', model: 'file', size: 100 };
        const mockVfs = {
            stat: vi.fn().mockResolvedValue(mockStat),
        };
        const mockProc = { user: 'test' };

        const results = await collect(fileStat(mockProc, mockVfs, '/test.txt'));

        expect(results).toEqual([{ op: 'ok', data: mockStat }]);
    });
});

describe('fileReaddir', () => {
    it('streams directory entries', async () => {
        const entries = [{ name: 'a.txt' }, { name: 'b.txt' }];
        const mockVfs = {
            readdir: vi.fn().mockImplementation(async function* () {
                for (const e of entries) yield e;
            }),
        };
        const mockProc = { user: 'test' };

        const results = await collect(fileReaddir(mockProc, mockVfs, '/dir'));

        expect(results).toEqual([
            { op: 'item', data: 'a.txt' },
            { op: 'item', data: 'b.txt' },
            { op: 'done' },
        ]);
    });
});
```

### Integration Tests

Integration tests use real kernel/vfs/ems/hal but can still be focused:

```typescript
// spec/syscall/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyscallDispatcher } from '../../src/syscall/index.js';
import { createTestKernel } from '../helpers.js';

describe('SyscallDispatcher integration', () => {
    let kernel, vfs, ems, hal, dispatcher;

    beforeEach(async () => {
        ({ kernel, vfs, ems, hal } = await createTestKernel());
        dispatcher = new SyscallDispatcher(kernel, vfs, ems, hal);
    });

    afterEach(async () => {
        await kernel.shutdown();
    });

    it('file:open -> file:write -> file:close roundtrip', async () => {
        const proc = kernel.getProcess(kernel.initPid);

        // Open
        const openResults = await collect(dispatcher.dispatch(proc, 'file:open', ['/test.txt', { write: true, create: true }]));
        expect(openResults[0].op).toBe('ok');
        const fd = openResults[0].data;

        // Write
        const data = new TextEncoder().encode('hello');
        const writeResults = await collect(dispatcher.dispatch(proc, 'file:write', [fd, data]));
        expect(writeResults[0].op).toBe('ok');

        // Close
        const closeResults = await collect(dispatcher.dispatch(proc, 'file:close', [fd]));
        expect(closeResults[0].op).toBe('ok');
    });
});
```

---

## Files to Create

| File | Description |
|------|-------------|
| `src/syscall/index.ts` | Exports `SyscallDispatcher` and types |
| `src/syscall/dispatcher.ts` | Main dispatcher with switch routing |
| `src/syscall/types.ts` | Shared types |
| `src/syscall/stream/index.ts` | Stream module exports |
| `src/syscall/stream/controller.ts` | StreamController (moved) |
| `src/syscall/stream/constants.ts` | Stream constants (moved) |
| `src/syscall/stream/types.ts` | Stream types (moved) |
| `src/syscall/vfs.ts` | All `file:*` and `fs:*` syscalls |
| `src/syscall/ems.ts` | All `ems:*` syscalls |
| `src/syscall/hal.ts` | All `net:*`, `port:*`, `channel:*` syscalls |
| `src/syscall/process.ts` | All `proc:*` syscalls + `activation:get` |
| `src/syscall/handle.ts` | All `handle:*` and `ipc:*` syscalls |
| `src/syscall/pool.ts` | All `pool:*` and `worker:*` syscalls |

## Files to Modify

| File | Changes |
|------|---------|
| `src/kernel/kernel.ts` | Add `SyscallDispatcher`, expose minimized interface |
| `src/kernel/index.ts` | Update exports |
| `AGENTS.md` | Update architecture diagram |

## Files to Delete (Phase 4)

| File | Reason |
|------|--------|
| `src/router/` | Replaced by `src/syscall/` |
| `src/kernel/syscalls/` | Replaced by `src/syscall/` |

---

## Summary

The syscall layer refactor:

1. **Separates concerns**: Kernel manages processes and handles. Syscalls orchestrate operations across kernel, VFS, EMS, and HAL.

2. **Simplifies testing**: Syscalls can be unit-tested with mocked dependencies.

3. **Makes dependencies explicit**: Each syscall declares exactly what it needs in its function signature.

4. **Yields errors instead of throwing**: Consistent error handling across all syscalls.

5. **Preserves streaming/backpressure**: StreamController moves to `src/syscall/stream/`.

6. **Enables future optimizations**: Clear boundaries make it easier to add caching, batching, or other optimizations at the syscall layer.

---

## Code Review (2024-12-07)

**Reviewer perspective**: Linux kernel dev + Staff TypeScript engineer
**Scope**: `src/syscall/` (completed Phase 4)

### Overall Assessment

The architecture is solid. The separation of concerns is clean: dispatcher routes to domain files, dependencies are explicit, and streaming uses proper backpressure. The documentation headers follow the kernel-dev style well.

---

### Critical Issues

#### 1. Race Condition: Process lookup during stream message routing
**File**: `dispatcher.ts:541-548`

```typescript
for (const proc of this.kernel.processes.all()) {
    if (proc.activeStreams.has(msg.id)) {
        pid = proc.id;
        break;
    }
}
```

**Problem**: Iterating `processes.all()` while another async operation could modify the process table. If a process exits during iteration, this could throw or return stale data.

**Mitigation**: The kernel should provide an atomic lookup method: `kernel.processes.findByStreamId(streamId)`.

---

#### 2. TOCTOU Bug in procChdir
**File**: `process.ts:300-318`

```typescript
const stat = await vfs.stat(resolved, proc.user);
if (stat.model !== 'folder') { ... }
// ^^^ Directory could be deleted here
proc.cwd = resolved;
```

**Problem**: Classic time-of-check-time-of-use. Directory could be deleted between stat() and setting cwd.

**Impact**: Process cwd points to non-existent directory. Relative path resolution may fail unexpectedly.

**Mitigation**: Either document this as acceptable (like POSIX) or use an atomic chdir in VFS that returns error if directory doesn't exist.

---

#### 3. Memory Leak: safetyTimeoutId not cleared on early exit
**File**: `stream/controller.ts:402-408`

```typescript
private waitForResume(): Promise<void> {
    return new Promise<void>(resolve => {
        this.resumeResolve = resolve;
        this.safetyTimeoutId = this.deps.setTimeout(() => { ... }, ...);
    });
}
```

**Problem**: If `wrap()` exits early (via abort or throw), `safetyTimeoutId` is never cleared. The timeout callback will fire after the controller is discarded.

**Mitigation**: Add cleanup in a wrapper or document that callers must call `clearSafetyTimeout()` manually.

---

### High Priority Issues

#### 4. Duplicate poolStats definition
**Files**: `process.ts:405-409` and `pool.ts:73-77`

Both files define identical `poolStats()` functions. The dispatcher imports from `process.ts` (line 69), making `pool.ts:73-77` dead code.

**Fix**: Remove one. Logically belongs in `pool.ts`.

---

#### 5. Inconsistent error code preservation
**File**: `ems.ts` (all syscalls), `vfs.ts:421-424`

```typescript
// ems.ts pattern - loses error code
catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield respond.error('EIO', msg);
}

// vfs.ts fileReaddir - also loses code
catch (err) {
    yield respond.error('ENOENT', (err as Error).message);
}
```

**Compare to** `process.ts:309-311` which correctly preserves:
```typescript
const code = (err as { code?: string }).code ?? 'ENOENT';
yield respond.error(code, (err as Error).message);
```

**Fix**: Standardize error handling. Consider a helper:
```typescript
function yieldError(err: unknown, defaultCode: string): Response {
    const e = err as Error & { code?: string };
    return respond.error(e.code ?? defaultCode, e.message ?? String(err));
}
```

---

#### 6. Missing MAX_STREAM_ENTRIES limit in emsSelect
**File**: `ems.ts:71-76`

```typescript
for await (const record of ems.ops.selectAny(model, filterData)) {
    yield respond.item(record);  // No count limit!
}
```

**Compare to** `vfs.ts:406-415` which enforces the limit:
```typescript
if (count > MAX_STREAM_ENTRIES) {
    yield respond.error('EFBIG', ...);
    return;
}
```

**Impact**: Unbounded query could exhaust memory or stall consumer.

---

#### 7. Inconsistent process state checking
**File**: `handle.ts:137-141` vs everywhere else

Only `handleSend` checks process state:
```typescript
if (proc.state !== 'running') {
    yield respond.error('ESRCH', 'Process is not running');
    return;
}
```

Other syscalls (fileRead, fileWrite, channelCall, etc.) don't check this.

**Question**: Is this check necessary? If yes, it should be in all syscalls. If no, remove it from handleSend.

---

### Medium Priority Issues

#### 8. Unused VFS parameter pattern
**File**: `vfs.ts:77-81, 612-616, 646-650`

Multiple syscalls accept `vfs: VFS` but don't use it:
```typescript
export async function* fileOpen(
    proc: Process,
    kernel: Kernel,
    _vfs: VFS,  // Unused - delegates to openFile(kernel, ...)
    ...
)
```

**Impact**: Confusing API. Caller passes VFS but kernel's internal VFS is used.

**Options**:
1. Use the passed VFS consistently
2. Remove VFS parameter where unused
3. Document why (kernel policy enforcement needs kernel's VFS reference)

---

#### 9. fileRmdir calls vfs.unlink
**File**: `vfs.ts:381-383`

```typescript
export async function* fileRmdir(...) {
    await vfs.unlink(path, proc.user);  // Same as fileUnlink?
}
```

**Question**: Should this call `vfs.rmdir()` instead? Or does VFS's `unlink()` handle directories? If the latter, document it.

---

#### 10. Unix socket via connectTcp with magic port 0
**File**: `hal.ts:94-97`

```typescript
case 'unix':
    yield respond.ok(await connectTcp(kernel, proc, host, 0));
```

**Issue**: Using port 0 as discriminator is a magic number pattern. Confusing that Unix sockets use `connectTcp`.

**Suggestion**: Consider `connectUnix()` or at minimum document why.

---

#### 11. Uint8Array check may fail across realms
**File**: `hal.ts:215-218`

```typescript
if (!(data instanceof Uint8Array)) {
    yield respond.error('EINVAL', 'data must be Uint8Array');
}
```

**Issue**: `instanceof` fails if data came from different JavaScript context (e.g., iframe, worker message).

**Fix**: Use `ArrayBuffer.isView(data)` or check constructor name.

---

### Minor Issues

#### 12. Indentation inconsistency in dispatcher.ts
Starting at line 194, section comment indentation is inconsistent with earlier sections:

```typescript
            case 'file:send':
                ...
                break;

                // =================================================================
                // MOUNT SYSCALLS (fs:*)  <- Extra indent
                // =================================================================
```

---

#### 13. Silent security event in onWorkerMessage
**File**: `dispatcher.ts:566-575`

Worker mismatch is silently dropped:
```typescript
if (proc.worker !== worker) {
    // Only sends error to syscall, no logging
    return;
}
```

**Suggestion**: Log this for security auditing. A worker sending messages claiming to be a different process is suspicious.

---

### Testability Observations

**Good**:
- `StreamController` has excellent test helpers (`gap`, `isPaused`, `sent`, `acked`, `isStalled()`)
- Dependencies are injectable via constructor
- Standalone functions enable unit testing with mocks

**Missing**:
- `SyscallDispatcher` has no test helpers (e.g., can't inspect active streams count)
- No centralized mock factory for kernel/vfs/ems/hal
- No way to inject custom dispatcher into kernel for integration tests

---

### Documentation Gaps

1. **Concurrency serialization claim** (`process.ts:33-34`): "Concurrent syscalls from the same process are serialized by the message queue" - where is this enforced? Should reference the code.

2. **VFS path sanitization**: Path arguments are validated as strings but no mention of path traversal protection. Document that VFS layer handles this.

3. **Resource limits**: No documented limits on handles, streams, etc. Is this intentional?

---

### Issue Summary

| Severity | Count | Action |
|----------|-------|--------|
| Critical | 3 | Fix before production |
| High | 4 | Fix in next sprint |
| Medium | 4 | Address when touching file |
| Minor | 2 | Nice to have |

The syscall layer is well-structured and follows the design doc. The critical issues are real but bounded in impact. The biggest win would be standardizing error handling across all syscalls with a shared utility.
