/**
 * Syscalls Module - Entry point for kernel syscall system
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module serves as the main export point for Monk OS's syscall infrastructure.
 * It re-exports all syscall types, the dispatcher, and syscall creator functions
 * that return handler registries for different subsystems (file, network, channel,
 * misc operations).
 *
 * The syscall system follows a modular design where handlers are grouped by domain
 * (file operations, network operations, etc.) and registered with the dispatcher
 * during kernel initialization. This separation enables:
 * - Clear ownership boundaries (VFS owns file syscalls, NetStack owns network syscalls)
 * - Testability (each subsystem's syscalls can be tested independently)
 * - Extensibility (new syscall domains can be added without modifying existing code)
 *
 * SyscallDispatcher routes incoming syscall requests from processes to registered
 * handlers. It validates process state, marshals arguments, invokes handlers, and
 * streams responses back to the calling process's worker thread.
 *
 * The registerSyscalls() function is the main entry point for kernel initialization.
 * It registers all syscall handlers with the kernel's dispatcher.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All exported syscall creators return valid SyscallRegistry objects
 * INV-2: SyscallDispatcher is initialized before any syscall can be invoked
 * INV-3: Handler names in registries must be unique across all subsystems
 * INV-4: All handlers conform to SyscallHandler signature (Process, ...args) => AsyncIterable<Response>
 *
 * CONCURRENCY MODEL
 * =================
 * Concurrency is handled at the dispatcher and handler levels:
 * - Dispatcher runs in kernel's main async context
 * - Multiple syscalls can execute concurrently from different processes
 * - Handlers must check process state after await points (see types.ts RC-1)
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * Race condition handling is documented in:
 * - types.ts: Handler execution model
 * - dispatcher.ts: Request routing and response delivery
 * - Individual handler modules (file.ts, network.ts, etc.)
 *
 * MEMORY MANAGEMENT
 * =================
 * - Exported types and functions are stateless
 * - No cleanup required - module is loaded once at kernel startup
 * - Handler registries are long-lived (kernel lifetime) but small
 *
 * @module kernel/syscalls
 */

import type { Kernel } from '../kernel.js';
import type { Process, SpawnOpts } from '../types.js';
import type { Response, Message } from '@src/message.js';
import { respond } from '@src/message.js';
import {
    assertString,
    assertNonNegativeInt,
    assertPositiveInt,
    assertObject,
    optionalString,
    optionalPositiveInt,
} from '../validate.js';

// Kernel functions
import { spawn } from '../kernel/spawn.js';
import { exit } from '../kernel/exit.js';
import { kill } from '../kernel/kill.js';
import { wait } from '../kernel/wait.js';
import { getpid } from '../kernel/get-pid.js';
import { getppid } from '../kernel/get-ppid.js';
import { closeHandle } from '../kernel/close-handle.js';
import { getHandle } from '../kernel/get-handle.js';
import { openFile } from '../kernel/open-file.js';
import { connectTcp } from '../kernel/connect-tcp.js';
import { createPipe } from '../kernel/create-pipe.js';
import { redirectHandle } from '../kernel/redirect-handle.js';
import { restoreHandle } from '../kernel/restore-handle.js';
import { createPort } from '../kernel/create-port.js';
import { getPortFromHandle } from '../kernel/get-port-from-handle.js';
import { recvPort } from '../kernel/recv-port.js';
import { openChannel } from '../kernel/open-channel.js';
import { getChannelFromHandle } from '../kernel/get-channel-from-handle.js';
import { leaseWorker } from '../kernel/lease-worker.js';
import { workerLoad } from '../kernel/load-worker.js';
import { workerSend } from '../kernel/send-worker.js';
import { workerRecv } from '../kernel/recv-worker.js';
import { workerRelease } from '../kernel/release-worker.js';
import { mountFs } from '../kernel/mount-fs.js';
import { umountFs } from '../kernel/umount-fs.js';

// Syscall creators
import { createFileSyscalls } from './file.js';
import { createMiscSyscalls } from './misc.js';
import { createNetworkSyscalls } from './network.js';
import { createChannelSyscalls } from './channel.js';

// =============================================================================
// TYPE EXPORTS
// =============================================================================

/**
 * Core syscall types and interfaces.
 *
 * WHY: These types are used throughout the kernel for syscall registration,
 * dispatch, and port-based I/O. Exporting them here provides a single
 * import location for all syscall-related types.
 */
export type { SyscallHandler, SyscallRegistry, ProcessPortMessage } from './types.js';

// =============================================================================
// DISPATCHER EXPORT
// =============================================================================

/**
 * Syscall dispatcher for routing requests to handlers.
 *
 * WHY: The dispatcher is the kernel's main entry point for syscall execution.
 * Exported here so kernel initialization code can create and configure a
 * dispatcher instance with all registered handlers.
 */
export { SyscallDispatcher } from './dispatcher.js';

// =============================================================================
// SYSCALL CREATOR EXPORTS
// =============================================================================

/**
 * File system syscall handlers.
 *
 * WHY: File operations (open, read, write, close, stat, etc.) are grouped
 * together because they all interact with the VFS subsystem and share common
 * permissions checks and handle management.
 *
 * USAGE: Kernel calls createFileSyscalls(deps) and registers handlers:
 * - fs:open, fs:read, fs:write, fs:close
 * - fs:stat, fs:readdir, fs:mkdir, fs:unlink
 * - fs:seek, fs:tell, fs:sync
 */
export { createFileSyscalls } from './file.js';

/**
 * Miscellaneous syscall handlers.
 *
 * WHY: General-purpose syscalls that don't fit into file/network/channel
 * domains. Includes process management (getpid, exit), time (clock), and
 * other kernel utilities.
 *
 * USAGE: Kernel calls createMiscSyscalls(deps) and registers handlers:
 * - misc:getpid, misc:exit
 * - misc:clock, misc:sleep
 * - misc:log, misc:debug
 */
export { createMiscSyscalls } from './misc.js';

/**
 * Network syscall handlers.
 *
 * WHY: Network operations (tcp, udp, dns) are isolated from file operations
 * because they interact with the NetStack subsystem and have different
 * permission models (network ACLs vs file permissions).
 *
 * USAGE: Kernel calls createNetworkSyscalls(deps) and registers handlers:
 * - net:tcp:connect, net:tcp:listen, net:tcp:accept
 * - net:udp:bind, net:udp:send, net:udp:recv
 * - net:dns:resolve, net:dns:reverse
 */
export { createNetworkSyscalls } from './network.js';

/**
 * Channel (IPC) syscall handlers.
 *
 * WHY: Inter-process communication channels are separate from network sockets
 * because they bypass network stack and provide process-local message passing
 * with different security semantics (process permissions vs network ACLs).
 *
 * USAGE: Kernel calls createChannelSyscalls(deps) and registers handlers:
 * - chan:create, chan:connect, chan:send, chan:recv
 * - chan:close, chan:accept
 */
export { createChannelSyscalls } from './channel.js';

// =============================================================================
// SYSCALL REGISTRATION
// =============================================================================

/**
 * Register all syscall handlers with the kernel.
 *
 * This is the main entry point for syscall initialization, called from
 * the Kernel constructor. It registers all syscall handlers with the
 * kernel's dispatcher.
 *
 * DESIGN: Syscalls are the kernel API exposed to userspace.
 * Each syscall is an async generator: (proc, ...args) => AsyncIterable<Response>
 *
 * @param kernel - The kernel instance to register syscalls with
 */
export function registerSyscalls(kernel: Kernel): void {
    /**
     * Wrap an async function as an async generator.
     *
     * WHY: Most syscalls return a single value. This helper avoids
     * boilerplate `async function* () { yield respond.ok(await fn()) }`
     */
    const wrapSyscall = <T>(fn: (proc: Process, ...args: unknown[]) => Promise<T> | T) => {
        return async function* (proc: Process, ...args: unknown[]): AsyncIterable<Response> {
            const result = await fn(proc, ...args);
            yield respond.ok(result);
        };
    };

    // -------------------------------------------------------------------------
    // PROCESS SYSCALLS
    // These manage process lifecycle: spawn, exit, kill, wait
    // -------------------------------------------------------------------------

    kernel.syscalls.registerAll({
        /**
         * spawn(entry, opts?) -> pid
         *
         * Create a child process. Returns PID in parent's namespace.
         * Child inherits parent's environment and stdio (unless overridden).
         */
        spawn: wrapSyscall((proc, entry, opts) => {
            assertString(entry, 'entry');
            return spawn(kernel, proc, entry, opts as SpawnOpts);
        }),

        /**
         * exit(code) -> never
         *
         * Terminate the calling process. Never returns.
         * All handles are closed, children reparented to init.
         */
        exit: wrapSyscall((proc, code) => {
            assertNonNegativeInt(code, 'code');
            return exit(kernel, proc, code);
        }),

        /**
         * kill(pid, signal?) -> void
         *
         * Send a signal to a process. Default signal is SIGTERM.
         * SIGKILL forces immediate termination.
         */
        kill: wrapSyscall((proc, pid, signal) => {
            assertPositiveInt(pid, 'pid');
            const sig = optionalPositiveInt(signal, 'signal');
            return kill(kernel, proc, pid, sig);
        }),

        /**
         * wait(pid, timeout?) -> ExitStatus
         *
         * Wait for a child process to exit.
         * Optional timeout in milliseconds; throws ETIMEDOUT if exceeded.
         */
        wait: wrapSyscall((proc, pid, timeout) => {
            assertPositiveInt(pid, 'pid');
            const ms = optionalPositiveInt(timeout, 'timeout');
            return wait(kernel, proc, pid, ms);
        }),

        /**
         * getpid() -> pid
         *
         * Get the PID of the calling process (in parent's namespace).
         */
        getpid: wrapSyscall((proc) => getpid(kernel, proc)),

        /**
         * getppid() -> pid
         *
         * Get the PID of the parent process (in grandparent's namespace).
         */
        getppid: wrapSyscall((proc) => getppid(kernel, proc)),
    });

    // -------------------------------------------------------------------------
    // FILE SYSCALLS
    // Delegated to createFileSyscalls for separation of concerns
    // -------------------------------------------------------------------------

    kernel.syscalls.registerAll(
        createFileSyscalls(
            kernel.vfs,
            kernel.hal,
            (proc, fd) => getHandle(kernel, proc, fd),
            (proc, path, flags) => openFile(kernel, proc, path, flags),
            (proc, fd) => closeHandle(kernel, proc, fd)
        )
    );

    // -------------------------------------------------------------------------
    // MOUNT SYSCALLS
    // Runtime mount/unmount with policy enforcement
    // -------------------------------------------------------------------------

    kernel.syscalls.registerAll({
        /**
         * fs:mount(source, target, opts?) -> void
         *
         * Mount a source to a target path.
         * Subject to mount policy rules.
         *
         * Sources:
         * - 'host:/path'  - Host filesystem directory
         * - 's3://bucket' - S3 bucket (future)
         * - 'tmpfs'       - Temporary in-memory filesystem
         *
         * @throws EPERM if mount policy denies the operation
         * @throws EACCES if requireGrant check fails
         */
        'fs:mount': wrapSyscall(async (proc, source, target, opts) => {
            assertString(source, 'source');
            assertString(target, 'target');
            return mountFs(kernel, proc, source, target, opts as Record<string, unknown> | undefined);
        }),

        /**
         * fs:umount(target) -> void
         *
         * Unmount a path.
         * Subject to mount policy rules (same rules as mount).
         *
         * @throws EPERM if mount policy denies the operation
         * @throws EINVAL if target is not mounted
         */
        'fs:umount': wrapSyscall(async (proc, target) => {
            assertString(target, 'target');
            return umountFs(kernel, proc, target);
        }),
    });

    // -------------------------------------------------------------------------
    // NETWORK SYSCALLS
    // Delegated to createNetworkSyscalls
    // -------------------------------------------------------------------------

    kernel.syscalls.registerAll(
        createNetworkSyscalls(
            kernel.hal,
            (proc, host, port) => connectTcp(kernel, proc, host, port),
            (proc, type, opts) => createPort(kernel, proc, type, opts),
            (proc, h) => getPortFromHandle(kernel, proc, h),
            (proc, h) => recvPort(kernel, proc, h),
            (proc, h) => closeHandle(kernel, proc, h)
        )
    );

    // -------------------------------------------------------------------------
    // MISC SYSCALLS
    // getcwd, chdir, getenv, setenv, etc.
    // -------------------------------------------------------------------------

    kernel.syscalls.registerAll(createMiscSyscalls(kernel.vfs));

    // -------------------------------------------------------------------------
    // CHANNEL SYSCALLS
    // Protocol-aware I/O: HTTP, WebSocket, PostgreSQL
    // -------------------------------------------------------------------------

    kernel.syscalls.registerAll(
        createChannelSyscalls(
            kernel.hal,
            (proc, proto, url, opts) => openChannel(kernel, proc, proto, url, opts),
            (proc, ch) => getChannelFromHandle(kernel, proc, ch),
            (proc, ch) => closeHandle(kernel, proc, ch)
        )
    );

    // -------------------------------------------------------------------------
    // PIPE SYSCALL
    // Create a unidirectional message pipe
    // -------------------------------------------------------------------------

    kernel.syscalls.register('pipe', wrapSyscall((proc) => createPipe(kernel, proc)));

    // -------------------------------------------------------------------------
    // HANDLE REDIRECTION SYSCALLS
    // For shell I/O redirection (e.g., cmd > file)
    // -------------------------------------------------------------------------

    kernel.syscalls.register('handle:redirect', wrapSyscall((proc, args) => {
        assertObject(args, 'args');
        assertNonNegativeInt(args['target'], 'target');
        assertNonNegativeInt(args['source'], 'source');
        return redirectHandle(kernel, proc, args['target'] as number, args['source'] as number);
    }));

    kernel.syscalls.register('handle:restore', wrapSyscall((proc, args) => {
        assertObject(args, 'args');
        assertNonNegativeInt(args['target'], 'target');
        assertString(args['saved'], 'saved');
        return restoreHandle(kernel, proc, args['target'] as number, args['saved'] as string);
    }));

    // -------------------------------------------------------------------------
    // WORKER POOL SYSCALLS
    // Kernel-managed worker pools for compute tasks
    // -------------------------------------------------------------------------

    kernel.syscalls.register('pool:lease', wrapSyscall((proc, pool) => {
        const poolName = optionalString(pool, 'pool');
        return leaseWorker(kernel, proc, poolName);
    }));

    kernel.syscalls.register('worker:load', wrapSyscall((proc, args) => {
        assertObject(args, 'args');
        assertString(args['workerId'], 'workerId');
        assertString(args['path'], 'path');
        return workerLoad(kernel, proc, args['workerId'] as string, args['path'] as string);
    }));

    kernel.syscalls.register('worker:send', wrapSyscall((proc, args) => {
        assertObject(args, 'args');
        assertString(args['workerId'], 'workerId');
        return workerSend(kernel, proc, args['workerId'] as string, args['msg']);
    }));

    kernel.syscalls.register('worker:recv', wrapSyscall((proc, workerId) => {
        assertString(workerId, 'workerId');
        return workerRecv(kernel, proc, workerId);
    }));

    kernel.syscalls.register('worker:release', wrapSyscall((proc, workerId) => {
        assertString(workerId, 'workerId');
        return workerRelease(kernel, proc, workerId);
    }));

    // Pool stats doesn't need a process context
    const poolManager = kernel.poolManager;
    kernel.syscalls.register('pool:stats', async function* (): AsyncIterable<Response> {
        yield respond.ok(poolManager.stats());
    });

    // -------------------------------------------------------------------------
    // UNIFIED HANDLE SYSCALLS
    // Generic handle operations that work on any handle type
    // -------------------------------------------------------------------------

    /**
     * handle:send - Send a message through a handle.
     *
     * Works on: pipes (send end), ports (UDP, pubsub), channels (HTTP, WS)
     * The message is handle-type-specific.
     */
    kernel.syscalls.register('handle:send', async function* (
        proc: Process,
        h: unknown,
        msg: unknown
    ): AsyncIterable<Response> {
        // Validate handle argument
        if (typeof h !== 'number') {
            yield respond.error('EINVAL', 'handle must be a number');
            return;
        }

        // RACE FIX: Check process state before operation
        if (proc.state !== 'running') {
            yield respond.error('ESRCH', 'Process is not running');
            return;
        }

        const handle = getHandle(kernel, proc, h);
        if (!handle) {
            yield respond.error('EBADF', `Bad handle: ${h}`);
            return;
        }

        yield* handle.exec(msg as Message);
    });

    /**
     * handle:close - Close a handle.
     *
     * Uses reference counting; only closes underlying resource
     * when last reference is released.
     */
    kernel.syscalls.register('handle:close', wrapSyscall((proc, h) =>
        closeHandle(kernel, proc, h as number)
    ));

    // -------------------------------------------------------------------------
    // SERVICE ACTIVATION SYSCALL
    // Allows service handlers to retrieve their activation message
    // -------------------------------------------------------------------------

    kernel.syscalls.register('activation:get', wrapSyscall((proc) => proc.activationMessage ?? null));
}
