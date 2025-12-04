/**
 * Kernel - The Central Coordinator for Monk OS
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This kernel follows a microkernel-inspired design where:
 * - Processes are isolated Bun Workers with UUID identity
 * - All I/O is unified through the Handle abstraction
 * - Communication is message-based (never shared memory except HAL primitives)
 * - Syscalls return AsyncIterable<Response> for streaming with backpressure
 *
 * STATE MACHINE
 * =============
 * Process lifecycle:
 *   starting -> running -> zombie
 *                 |
 *                 +-> stopped (future: SIGSTOP/SIGCONT)
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: A process in 'zombie' state has no active worker
 * INV-2: handleRefs[id] >= 1 for any id in handles map
 * INV-3: proc.handles[fd] references a valid entry in kernel.handles
 * INV-4: Init process (PID 1) exists from boot until shutdown
 * INV-5: A child's parent field always references a valid process or ''
 * INV-6: No two processes share the same UUID
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but we have async operations:
 * - Worker.postMessage is synchronous (enqueues, doesn't block)
 * - Syscall handlers are async generators
 * - Multiple syscalls from same process can interleave at await points
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check process.state after every await in syscall handlers
 * RC-2: Use AbortController for cancellable operations
 * RC-3: Clean up waiters on timeout (don't leave dangling callbacks)
 * RC-4: Validate handle existence before every operation
 *
 * MEMORY MANAGEMENT
 * =================
 * - Handles use reference counting (refHandle/unrefHandle)
 * - Zombies hold no resources (handles closed on exit)
 * - Waiters are cleaned up on resolution OR timeout
 * - Service activation ports are tracked and cleaned on shutdown
 *
 * @module kernel
 */

import type { HAL } from '@src/hal/index.js';
import type { VFS } from '@src/vfs/index.js';
import type {
    Process,
    SpawnOpts,
    ExitStatus,
    SyscallRequest,
    SignalMessage,
    KernelMessage,
    BootEnv,
    OpenFlags,
} from '@src/kernel/types.js';
import { SIGTERM, SIGKILL, TERM_GRACE_MS } from '@src/kernel/types.js';
import { poll } from '@src/kernel/poll.js';
import { ProcessTable } from '@src/kernel/process-table.js';
import { MAX_HANDLES, STREAM_HIGH_WATER, STREAM_LOW_WATER, STREAM_STALL_TIMEOUT } from '@src/kernel/types.js';
import type { Handle } from '@src/kernel/handle.js';
import { FileHandleAdapter, SocketHandleAdapter, PortHandleAdapter, ChannelHandleAdapter, ProcessIOHandle, ConsoleHandleAdapter } from '@src/kernel/handle.js';
import {
    SyscallDispatcher,
    createFileSyscalls,
    createMiscSyscalls,
    createNetworkSyscalls,
    createChannelSyscalls,
} from '@src/kernel/syscalls.js';
import type { Channel, ChannelOpts } from '@src/hal/index.js';
import { ESRCH, ECHILD, ProcessExited, EBADF, EPERM, EINVAL, EMFILE, ETIMEDOUT, EACCES, ENOTSUP, EBUSY } from '@src/kernel/errors.js';
import type { Port } from '@src/kernel/resource.js';
import type { WatchEvent } from '@src/vfs/model.js';
import { ListenerPort, WatchPort, UdpPort, PubsubPort, matchTopic, createMessagePipe } from '@src/kernel/resource.js';
import type { ProcessPortMessage } from '@src/kernel/syscalls.js';
import { respond } from '@src/message.js';
import type { Response, Message } from '@src/message.js';
import type { ServiceDef, IOSource, IOTarget } from '@src/kernel/services.js';
import { loadMounts } from '@src/kernel/mounts.js';
import { copyRomToVfs } from '@src/kernel/boot.js';
import { VFSLoader } from '@src/kernel/loader.js';
import { PoolManager, type LeasedWorker } from '@src/kernel/pool.js';
import {
    createDatabase,
    ModelCache,
    EntityCache,
    DatabaseOps,
    createObserverRunner,
} from '@src/model/index.js';
import {
    assertString,
    assertNonNegativeInt,
    assertPositiveInt,
    assertObject,
    optionalString,
    optionalPositiveInt,
} from '@src/kernel/validate.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Path to the console device in VFS.
 * Used for init process stdio and service default I/O.
 */
const CONSOLE_PATH = '/dev/console';

/**
 * Delay before revoking blob URLs for worker scripts.
 * Workers need time to load the script before we can safely revoke.
 * Too short = script fails to load. Too long = memory pressure.
 */
const BLOB_URL_REVOKE_DELAY_MS = 1000;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Dependencies that can be injected for testing.
 *
 * TESTABILITY: By extracting these, tests can:
 * - Mock time functions to test timeouts without waiting
 * - Inject mock worker factories to avoid real Worker creation
 * - Control entropy for deterministic UUIDs in tests
 */
export interface KernelDeps {
    /** Current time in milliseconds (default: Date.now) */
    now: () => number;

    /** Schedule a callback (default: setTimeout) */
    setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;

    /** Cancel a scheduled callback (default: clearTimeout) */
    clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

/**
 * Information about an active waiter.
 * RACE CONDITION FIX: We track waiters with cleanup functions
 * so timeouts can properly remove their callbacks.
 */
interface WaiterEntry {
    /** Callback to invoke with exit status */
    callback: (status: ExitStatus) => void;

    /** Cleanup function to remove this waiter (called on timeout) */
    cleanup: () => void;
}

/**
 * State for tracking a streaming syscall's backpressure.
 *
 * BACKPRESSURE ALGORITHM:
 * 1. Kernel tracks items sent vs items consumer has acknowledged
 * 2. When gap >= HIGH_WATER, pause yielding (apply backpressure)
 * 3. When gap <= LOW_WATER, resume yielding
 * 4. Consumer sends 'stream_ping' every 100ms with items processed count
 * 5. If no ping for STALL_TIMEOUT, abort stream (consumer is dead/stuck)
 */
interface StreamState {
    /** Total items sent to consumer */
    itemsSent: number;

    /** Items consumer has acknowledged processing */
    itemsAcked: number;

    /** Timestamp of last ping from consumer */
    lastPingTime: number;

    /** Resolve function to resume from backpressure pause */
    resumeResolve: (() => void) | null;

    /** AbortController to cancel stream on request */
    abort: AbortController;
}

/**
 * Mount policy rule.
 *
 * Defines who can mount what sources to which targets.
 * Rules are evaluated in order; first match wins.
 *
 * PATTERN SYNTAX:
 * - '*' matches any single path component
 * - '**' matches any number of path components
 * - '{caller}' substitutes the caller's UUID
 * - '{tenant}' substitutes the caller's tenant (from JWT claims, future)
 *
 * EXAMPLES:
 * - { caller: '*', source: '*', target: '/home/{caller}/**' }
 *   Any user can mount anything to their home directory
 *
 * - { caller: 'kernel', source: '*', target: '*' }
 *   Kernel can mount anything anywhere
 *
 * - { caller: '*', source: 's3:*', target: '/vol/**', requireGrant: 'mount' }
 *   Users can mount S3 buckets to /vol if they have 'mount' grant on target
 */
export interface MountPolicyRule {
    /** Caller pattern ('*' = any, or specific UUID) */
    caller: string;

    /** Source pattern (e.g., 'host:*', 's3:*', '*') */
    source: string;

    /** Target path pattern (e.g., '/home/{caller}/**') */
    target: string;

    /**
     * If set, caller must have this grant on target directory.
     * Checked via VFS ACL.
     */
    requireGrant?: string;

    /** Human-readable description for logging/debugging */
    description?: string;
}

/**
 * Mount policy configuration.
 */
export interface MountPolicy {
    /** Ordered list of rules (first match wins) */
    rules: MountPolicyRule[];
}

/**
 * Default mount policy.
 *
 * WHY RESTRICTIVE: Mounts affect namespace visibility.
 * Default allows only kernel to mount.
 * Users configure additional rules via OS API or /etc/mounts.policy.json.
 */
const DEFAULT_MOUNT_POLICY: MountPolicy = {
    rules: [
        // Kernel can mount anything anywhere (needed for boot)
        { caller: 'kernel', source: '*', target: '*', description: 'Kernel unrestricted' },

        // World-writable /tmp allows user mounts
        { caller: '*', source: '*', target: '/tmp/**', description: 'Temp mounts' },
    ],
};

/**
 * FUTURE: Process mount namespace.
 *
 * Currently all mounts are global (shared by all processes).
 * Future work will add per-process mount namespaces for:
 * - Per-request tenant isolation (authd use case)
 * - Container-like isolation
 * - User-specific views
 *
 * Design sketch:
 * ```typescript
 * interface MountNamespace {
 *     id: string;
 *     parent: string | null;  // For namespace inheritance
 *     mounts: Map<string, MountInfo>;  // Path -> mount
 * }
 *
 * // Process would have:
 * interface Process {
 *     // ...existing fields...
 *     mountNamespace: string;  // Namespace UUID
 * }
 * ```
 *
 * For now, this is documented intent only.
 */

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Format an error for logging.
 *
 * WHY: Consistent error formatting across the kernel. We extract the message
 * from Error objects but handle non-Error throws (which are valid in JS).
 */
function formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Default kernel dependencies using real implementations.
 */
function createDefaultDeps(): KernelDeps {
    return {
        now: () => Date.now(),
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (id) => clearTimeout(id),
    };
}

// =============================================================================
// KERNEL CLASS
// =============================================================================

/**
 * The Monk OS Kernel
 *
 * Responsible for:
 * - Process lifecycle (spawn, exit, kill, wait)
 * - Syscall dispatch and response streaming
 * - Handle management with reference counting
 * - Service activation (boot, tcp, udp, pubsub, watch)
 * - Worker pool management
 *
 * NOT responsible for (handled by other subsystems):
 * - File system operations (VFS)
 * - Hardware access (HAL)
 * - Path resolution (VFS)
 * - Module loading (VFSLoader)
 */
export class Kernel {
    // =========================================================================
    // CORE DEPENDENCIES
    // =========================================================================

    /**
     * Hardware Abstraction Layer - provides access to:
     * - entropy (UUIDs, random)
     * - console (stdin/stdout/stderr)
     * - network (TCP/UDP)
     * - channel (HTTP, WebSocket, PostgreSQL)
     */
    private readonly hal: HAL;

    /**
     * Virtual File System - provides:
     * - Path resolution
     * - File/folder operations
     * - Device files (/dev/*)
     * - Process info (/proc/*)
     */
    private readonly vfs: VFS;

    /**
     * Injectable dependencies for testability.
     * Production uses real implementations; tests can mock.
     */
    private readonly deps: KernelDeps;

    // =========================================================================
    // PROCESS MANAGEMENT
    // =========================================================================

    /**
     * Process table - maps UUID to Process objects.
     * INVARIANT: All running/starting processes are in this table.
     * Zombies remain until reaped by parent's wait().
     */
    private readonly processes: ProcessTable;

    /**
     * Wait queue - processes blocked on wait() syscall.
     *
     * Key: target process UUID
     * Value: list of waiters (callbacks + cleanup functions)
     *
     * RACE FIX: Each waiter has a cleanup function that removes it from
     * the list. This is called on timeout to prevent memory leaks.
     */
    private readonly waiters: Map<string, WaiterEntry[]> = new Map();

    // =========================================================================
    // HANDLE MANAGEMENT
    // =========================================================================

    /**
     * Global handle table - maps handle UUID to Handle object.
     *
     * WHY GLOBAL: Handles can be shared between processes (e.g., inherited
     * stdio, pipes). Reference counting tracks sharing.
     *
     * INVARIANT: If handles.has(id), then handleRefs.get(id) >= 1
     */
    private readonly handles: Map<string, Handle> = new Map();

    /**
     * Handle reference counts.
     *
     * WHY: Multiple processes can reference the same handle (e.g., parent
     * and child share stdout). We only close the underlying resource when
     * the last reference is released.
     *
     * INVARIANT: handleRefs.get(id) === number of proc.handles entries
     *            pointing to this handle ID across all processes
     */
    private readonly handleRefs: Map<string, number> = new Map();

    // =========================================================================
    // SYSCALL DISPATCH
    // =========================================================================

    /**
     * Syscall dispatcher - routes syscall names to handler functions.
     *
     * DESIGN: Syscalls are registered at kernel construction time.
     * Each handler is an async generator yielding Response objects.
     * This enables streaming results with backpressure.
     */
    private readonly syscalls: SyscallDispatcher;

    // =========================================================================
    // PUBSUB ROUTING
    // =========================================================================

    /**
     * Active pubsub ports for topic-based message routing.
     *
     * WHY SET: Need to iterate all ports on each publish to find subscribers.
     * Topic matching uses glob patterns (e.g., "log.*" matches "log.info").
     *
     * CLEANUP: Ports are removed when closed via unsubscribeFn callback.
     */
    private readonly pubsubPorts: Set<PubsubPort> = new Set();

    // =========================================================================
    // SERVICE MANAGEMENT
    // =========================================================================

    /**
     * Loaded service definitions by name.
     * Services are loaded from /etc/services/*.json at boot.
     */
    private readonly services: Map<string, ServiceDef> = new Map();

    /**
     * Activation ports by service name.
     * For tcp:listen, udp, watch, pubsub activation types.
     */
    private readonly activationPorts: Map<string, Port> = new Map();

    /**
     * Abort controllers for service activation loops.
     * Used to cleanly stop activation loops during shutdown.
     */
    private readonly activationAborts: Map<string, AbortController> = new Map();

    // =========================================================================
    // WORKER POOLS
    // =========================================================================

    /**
     * VFS module loader - bundles TypeScript for Worker execution.
     */
    private readonly loader: VFSLoader;

    /**
     * Worker pool manager - provides pooled workers for compute tasks.
     */
    private readonly poolManager: PoolManager;

    /**
     * Leased workers by process.
     * Outer map: process UUID -> inner map
     * Inner map: worker UUID -> LeasedWorker
     *
     * WHY NESTED: A process can lease multiple workers. On process exit,
     * we release all workers leased by that process.
     */
    private readonly leasedWorkers: Map<string, Map<string, LeasedWorker>> = new Map();

    // =========================================================================
    // MOUNT POLICY
    // =========================================================================

    /**
     * Mount policy rules (static, defined in code).
     *
     * Determines who can mount what sources to which targets.
     * Rules are evaluated in order; first match wins.
     */
    private readonly mountPolicy: MountPolicy = DEFAULT_MOUNT_POLICY;

    // =========================================================================
    // KERNEL STATE
    // =========================================================================

    /**
     * Boot state flag.
     *
     * STATE MACHINE:
     * - false: kernel not yet booted (or shutdown complete)
     * - true: kernel is running (boot succeeded)
     *
     * INVARIANT: If booted=true, init process exists in process table
     */
    private booted = false;

    /**
     * Debug logging flag.
     * When true, printk() outputs to console.
     * Set via boot environment debug flag.
     */
    private debugEnabled = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new kernel instance.
     *
     * NOTE: Constructor does NOT boot the kernel. Call boot() separately.
     * This allows configuration and hook registration before boot.
     *
     * @param hal - Hardware abstraction layer
     * @param vfs - Virtual file system
     * @param deps - Optional injectable dependencies for testing
     */
    constructor(hal: HAL, vfs: VFS, deps?: Partial<KernelDeps>) {
        this.hal = hal;
        this.vfs = vfs;
        this.deps = { ...createDefaultDeps(), ...deps };
        this.processes = new ProcessTable();
        this.syscalls = new SyscallDispatcher();
        this.loader = new VFSLoader(vfs, hal);
        this.poolManager = new PoolManager(hal);

        // Register all syscall handlers
        // WHY HERE: Syscalls are static - they don't change after construction
        this.registerSyscalls();
    }

    // =========================================================================
    // SYSCALL REGISTRATION
    // =========================================================================

    /**
     * Register all syscall handlers.
     *
     * DESIGN: Syscalls are the kernel API exposed to userspace.
     * Each syscall is an async generator: (proc, ...args) => AsyncIterable<Response>
     *
     * The wrapSyscall helper converts simple async functions into generators
     * that yield a single 'ok' response.
     */
    private registerSyscalls(): void {
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

        // ---------------------------------------------------------------------
        // PROCESS SYSCALLS
        // These manage process lifecycle: spawn, exit, kill, wait
        // ---------------------------------------------------------------------

        this.syscalls.registerAll({
            /**
             * spawn(entry, opts?) -> pid
             *
             * Create a child process. Returns PID in parent's namespace.
             * Child inherits parent's environment and stdio (unless overridden).
             */
            spawn: wrapSyscall((proc, entry, opts) => {
                assertString(entry, 'entry');
                return this.spawn(proc, entry, opts as SpawnOpts);
            }),

            /**
             * exit(code) -> never
             *
             * Terminate the calling process. Never returns.
             * All handles are closed, children reparented to init.
             */
            exit: wrapSyscall((proc, code) => {
                assertNonNegativeInt(code, 'code');
                return this.exit(proc, code);
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
                return this.kill(proc, pid, sig);
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
                return this.wait(proc, pid, ms);
            }),

            /**
             * getpid() -> pid
             *
             * Get the PID of the calling process (in parent's namespace).
             */
            getpid: wrapSyscall((proc) => this.getpid(proc)),

            /**
             * getppid() -> pid
             *
             * Get the PID of the parent process (in grandparent's namespace).
             */
            getppid: wrapSyscall((proc) => this.getppid(proc)),
        });

        // ---------------------------------------------------------------------
        // FILE SYSCALLS
        // Delegated to createFileSyscalls for separation of concerns
        // ---------------------------------------------------------------------

        this.syscalls.registerAll(
            createFileSyscalls(
                this.vfs,
                this.hal,
                (proc, fd) => this.getHandle(proc, fd),
                (proc, path, flags) => this.openFile(proc, path, flags),
                (proc, fd) => this.closeHandle(proc, fd)
            )
        );

        // ---------------------------------------------------------------------
        // MOUNT SYSCALLS
        // Runtime mount/unmount with policy enforcement
        // ---------------------------------------------------------------------

        this.syscalls.registerAll({
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
                return this.mountFs(proc, source, target, opts as Record<string, unknown> | undefined);
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
                return this.umountFs(proc, target);
            }),
        });

        // ---------------------------------------------------------------------
        // NETWORK SYSCALLS
        // Delegated to createNetworkSyscalls
        // ---------------------------------------------------------------------

        this.syscalls.registerAll(
            createNetworkSyscalls(
                this.hal,
                (proc, host, port) => this.connectTcp(proc, host, port),
                (proc, type, opts) => this.createPort(proc, type, opts),
                (proc, h) => this.getPortFromHandle(proc, h),
                (proc, h) => this.recvPort(proc, h),
                (proc, h) => this.closeHandle(proc, h)
            )
        );

        // ---------------------------------------------------------------------
        // MISC SYSCALLS
        // getcwd, chdir, getenv, setenv, etc.
        // ---------------------------------------------------------------------

        this.syscalls.registerAll(createMiscSyscalls(this.vfs));

        // ---------------------------------------------------------------------
        // CHANNEL SYSCALLS
        // Protocol-aware I/O: HTTP, WebSocket, PostgreSQL
        // ---------------------------------------------------------------------

        this.syscalls.registerAll(
            createChannelSyscalls(
                this.hal,
                (proc, proto, url, opts) => this.openChannel(proc, proto, url, opts),
                (proc, ch) => this.getChannelFromHandle(proc, ch),
                (proc, ch) => this.closeHandle(proc, ch)
            )
        );

        // ---------------------------------------------------------------------
        // PIPE SYSCALL
        // Create a unidirectional message pipe
        // ---------------------------------------------------------------------

        this.syscalls.register('pipe', wrapSyscall((proc) => this.createPipe(proc)));

        // ---------------------------------------------------------------------
        // HANDLE REDIRECTION SYSCALLS
        // For shell I/O redirection (e.g., cmd > file)
        // ---------------------------------------------------------------------

        this.syscalls.register('handle:redirect', wrapSyscall((proc, args) => {
            assertObject(args, 'args');
            assertNonNegativeInt(args['target'], 'target');
            assertNonNegativeInt(args['source'], 'source');
            return this.redirectHandle(proc, args['target'] as number, args['source'] as number);
        }));

        this.syscalls.register('handle:restore', wrapSyscall((proc, args) => {
            assertObject(args, 'args');
            assertNonNegativeInt(args['target'], 'target');
            assertString(args['saved'], 'saved');
            return this.restoreHandle(proc, args['target'] as number, args['saved'] as string);
        }));

        // ---------------------------------------------------------------------
        // WORKER POOL SYSCALLS
        // Kernel-managed worker pools for compute tasks
        // ---------------------------------------------------------------------

        this.syscalls.register('pool:lease', wrapSyscall((proc, pool) => {
            const poolName = optionalString(pool, 'pool');
            return this.leaseWorker(proc, poolName);
        }));

        this.syscalls.register('worker:load', wrapSyscall((proc, args) => {
            assertObject(args, 'args');
            assertString(args['workerId'], 'workerId');
            assertString(args['path'], 'path');
            return this.workerLoad(proc, args['workerId'] as string, args['path'] as string);
        }));

        this.syscalls.register('worker:send', wrapSyscall((proc, args) => {
            assertObject(args, 'args');
            assertString(args['workerId'], 'workerId');
            return this.workerSend(proc, args['workerId'] as string, args['msg']);
        }));

        this.syscalls.register('worker:recv', wrapSyscall((proc, workerId) => {
            assertString(workerId, 'workerId');
            return this.workerRecv(proc, workerId);
        }));

        this.syscalls.register('worker:release', wrapSyscall((proc, workerId) => {
            assertString(workerId, 'workerId');
            return this.workerRelease(proc, workerId);
        }));

        // Pool stats doesn't need a process context
        const poolManager = this.poolManager;
        this.syscalls.register('pool:stats', async function* (): AsyncIterable<Response> {
            yield respond.ok(poolManager.stats());
        });

        // ---------------------------------------------------------------------
        // UNIFIED HANDLE SYSCALLS
        // Generic handle operations that work on any handle type
        // ---------------------------------------------------------------------

        /**
         * handle:send - Send a message through a handle.
         *
         * Works on: pipes (send end), ports (UDP, pubsub), channels (HTTP, WS)
         * The message is handle-type-specific.
         */
        this.syscalls.register('handle:send', async function* (
            this: Kernel,
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

            const handle = this.getHandle(proc, h);
            if (!handle) {
                yield respond.error('EBADF', `Bad handle: ${h}`);
                return;
            }

            yield* handle.exec(msg as Message);
        }.bind(this));

        /**
         * handle:close - Close a handle.
         *
         * Uses reference counting; only closes underlying resource
         * when last reference is released.
         */
        this.syscalls.register('handle:close', wrapSyscall((proc, h) =>
            this.closeHandle(proc, h as number)
        ));

        // ---------------------------------------------------------------------
        // SERVICE ACTIVATION SYSCALL
        // Allows service handlers to retrieve their activation message
        // ---------------------------------------------------------------------

        this.syscalls.register('activation:get', wrapSyscall((proc) => proc.activationMessage ?? null));
    }

    // =========================================================================
    // DEBUG LOGGING
    // =========================================================================

    /**
     * Kernel debug logging (like Linux printk).
     *
     * WHY: Kernel-level debugging separate from application logging.
     * Only outputs when debug mode is enabled via boot flag.
     * Output goes directly to console, not through logd.
     *
     * @param category - Logging category (e.g., 'syscall', 'spawn', 'cleanup')
     * @param message - Log message
     */
    private printk(category: string, message: string): void {
        if (this.debugEnabled) {
            console.log(`[kernel:${category}] ${message}`);
        }
    }

    // =========================================================================
    // LIFECYCLE: BOOT
    // =========================================================================

    /**
     * Boot the kernel.
     *
     * BOOT SEQUENCE:
     * 1. Initialize VFS (creates root folder, /dev devices)
     * 2. Create standard directories (/app, /bin, /etc, /home, /tmp, /usr, /var, /vol)
     * 3. Copy ROM into VFS (bundled userspace code)
     * 4. Load mount policy from /etc/mounts.policy.json
     * 5. Load and apply mounts from /etc/mounts.json
     * 6. Load worker pool configuration
     * 7. Create init process (PID 1)
     * 8. Load and activate services
     * 9. Setup init stdio and start worker
     *
     * INVARIANT: After boot(), init process exists and is running.
     *
     * @param env - Boot environment configuration
     * @throws Error if already booted
     */
    async boot(env: BootEnv): Promise<void> {
        // Guard against double boot
        if (this.booted) {
            throw new EBUSY('Kernel already booted');
        }

        // Enable debug logging if requested
        this.debugEnabled = env.debug ?? false;
        this.printk('boot', 'Starting kernel boot sequence');

        // ---------------------------------------------------------------------
        // PHASE 1: VFS INITIALIZATION
        // ---------------------------------------------------------------------

        this.printk('boot', 'Initializing VFS');
        await this.vfs.init();

        // ---------------------------------------------------------------------
        // PHASE 1.2: DATABASE & ENTITY LAYER
        // Create database, model cache, observer pipeline, and entity cache.
        // Register FileModel and FolderModel with VFS so file/folder operations work.
        // ---------------------------------------------------------------------

        this.printk('boot', 'Initializing database and entity layer');
        const dbConn = await createDatabase(this.hal.channel, this.hal.file);
        const modelCache = new ModelCache(dbConn);
        const observerRunner = createObserverRunner();
        const dbOps = new DatabaseOps(dbConn, modelCache, observerRunner);
        const entityCache = new EntityCache();
        await entityCache.loadFromDatabase(dbConn);

        // Register entity-backed models with VFS (needed for file/folder operations)
        this.vfs.registerFileModel(dbOps, entityCache);
        this.vfs.registerFolderModel(dbOps, entityCache);
        this.printk('boot', `Entity cache loaded: ${entityCache.size} entities`);

        // ---------------------------------------------------------------------
        // PHASE 1.5: STANDARD DIRECTORY STRUCTURE
        // Create all core directories defensively before anything else runs.
        // This ensures a consistent filesystem layout regardless of ROM contents.
        // ---------------------------------------------------------------------

        this.printk('boot', 'Creating standard directory structure');
        await this.createStandardDirectories();

        // ---------------------------------------------------------------------
        // PHASE 2: ROM COPY
        // Copy bundled userspace code into VFS with proper UUIDs and ACLs
        // ---------------------------------------------------------------------

        const romPath = env.romPath ?? './rom';
        this.printk('boot', `Copying ROM to VFS from: ${romPath}`);
        await copyRomToVfs({ vfs: this.vfs }, romPath);

        // ---------------------------------------------------------------------
        // PHASE 3: MOUNTS, POLICY, AND POOLS
        // ---------------------------------------------------------------------

        this.printk('boot', 'Loading mounts');
        await loadMounts({ vfs: this.vfs, hal: this.hal, loader: this.loader });

        this.printk('boot', 'Loading pool configuration');
        await this.poolManager.loadConfig(this.vfs);

        // ---------------------------------------------------------------------
        // PHASE 4-6: INIT PROCESS (only if initPath provided)
        // Headless mode skips init process creation for tests/debugging
        // ---------------------------------------------------------------------

        if (env.initPath) {
            // PHASE 4: Init process creation
            this.printk('boot', `Creating init process: ${env.initPath}`);
            const init = this.createProcess({
                cmd: env.initPath,
                env: env.env,
                args: env.initArgs,
            });
            this.processes.register(init);

            // PHASE 5: Service activation
            this.printk('boot', 'Loading services');
            await this.loadServices();

            // PHASE 6: Init startup
            this.printk('boot', 'Setting up init stdio');
            await this.setupInitStdio(init);

            this.printk('boot', 'Starting init worker');
            init.worker = await this.spawnWorker(init, env.initPath);
            init.state = 'running';
        } else {
            this.printk('boot', 'Headless mode - skipping init process');
        }

        // Boot complete
        this.booted = true;
        this.printk('boot', 'Kernel boot complete');
    }

    /**
     * Create standard directory structure.
     *
     * FILESYSTEM HIERARCHY (inspired by FHS but simplified):
     * ```
     * /
     * ├── app/    - Application data and state
     * ├── bin/    - User commands (shell, utilities)
     * ├── etc/    - System configuration (services, mounts, pools)
     * ├── home/   - User home directories (per-user mounts)
     * ├── tmp/    - Temporary files (cleared on reboot)
     * ├── usr/    - Installed packages
     * ├── var/    - Variable data
     * │   └── log/  - Log files
     * └── vol/    - Mounted volumes (tenant storage)
     * ```
     *
     * WHY DEFENSIVE: Creating these early ensures:
     * 1. ROM copy has directories to write into
     * 2. Services have expected paths available
     * 3. No race between directory creation and first use
     * 4. Consistent layout regardless of ROM contents
     */
    private async createStandardDirectories(): Promise<void> {
        const standardDirs = [
            '/app',      // Application data and state
            '/bin',      // User commands
            '/etc',      // System configuration
            '/home',     // User home directories
            '/tmp',      // Temporary files
            '/usr',      // Installed packages
            '/var',      // Variable data
            '/var/log',  // Log files
            '/vol',      // Mounted volumes
        ];

        for (const dir of standardDirs) {
            try {
                await this.vfs.mkdir(dir, 'kernel', { recursive: true });
                this.printk('boot', `Created directory: ${dir}`);
            } catch (err) {
                // EEXIST is fine - directory already exists (idempotent)
                const error = err as Error & { code?: string };
                if (error.code !== 'EEXIST') {
                    this.printk('warn', `Failed to create ${dir}: ${formatError(err)}`);
                }
            }
        }
    }

    // =========================================================================
    // LIFECYCLE: SHUTDOWN
    // =========================================================================

    /**
     * Shutdown the kernel.
     *
     * SHUTDOWN SEQUENCE:
     * 1. Send SIGTERM to all non-init processes
     * 2. Wait grace period for graceful exit
     * 3. Send SIGKILL to all remaining processes (including init)
     * 4. Stop service activation loops
     * 5. Close activation ports
     * 6. Clear all state
     * 7. Shutdown worker pools
     *
     * DESIGN: We don't await individual process exits during SIGKILL phase.
     * Force exit is synchronous (terminate worker immediately).
     */
    async shutdown(): Promise<void> {
        if (!this.booted) {
            return; // Already shutdown or never booted
        }

        this.printk('shutdown', 'Starting kernel shutdown');

        // ---------------------------------------------------------------------
        // PHASE 1: GRACEFUL TERMINATION
        // Send SIGTERM and wait for processes to exit gracefully
        // ---------------------------------------------------------------------

        const init = this.processes.getInit();
        let runningCount = 0;

        for (const proc of this.processes.all()) {
            // Skip init - it's killed last
            if (proc !== init && proc.state === 'running') {
                this.deliverSignal(proc, SIGTERM);
                runningCount++;
            }
        }

        this.printk('shutdown', `Sent SIGTERM to ${runningCount} processes`);

        // Wait for processes to exit (with timeout)
        if (runningCount > 0) {
            await poll(() => {
                for (const proc of this.processes.all()) {
                    if (proc !== init && proc.state === 'running') {
                        return false; // Still running
                    }
                }
                return true; // All exited
            }, { timeout: TERM_GRACE_MS });
        }

        // ---------------------------------------------------------------------
        // PHASE 2: FORCED TERMINATION
        // Kill any remaining processes including init
        // ---------------------------------------------------------------------

        for (const proc of this.processes.all()) {
            if (proc.state === 'running' || proc.state === 'starting') {
                this.printk('shutdown', `Force killing process: ${proc.cmd}`);
                this.forceExit(proc, 128 + SIGKILL);
            }
        }

        // ---------------------------------------------------------------------
        // PHASE 3: SERVICE CLEANUP
        // Stop activation loops and close ports
        // ---------------------------------------------------------------------

        this.printk('shutdown', 'Stopping service activation loops');
        for (const abort of this.activationAborts.values()) {
            abort.abort();
        }

        this.printk('shutdown', 'Closing activation ports');
        for (const [name, port] of this.activationPorts) {
            await port.close().catch((err) => {
                this.printk('cleanup', `activation port ${name} close failed: ${formatError(err)}`);
            });
        }

        // ---------------------------------------------------------------------
        // PHASE 4: STATE CLEANUP
        // Clear all internal state
        // ---------------------------------------------------------------------

        this.processes.clear();
        this.handles.clear();
        this.handleRefs.clear();
        this.waiters.clear();
        this.services.clear();
        this.activationPorts.clear();
        this.activationAborts.clear();
        this.pubsubPorts.clear();

        // ---------------------------------------------------------------------
        // PHASE 5: POOL SHUTDOWN
        // ---------------------------------------------------------------------

        this.printk('shutdown', 'Shutting down worker pools');
        this.poolManager.shutdown();
        this.leasedWorkers.clear();

        this.booted = false;
        this.printk('shutdown', 'Kernel shutdown complete');
    }

    // =========================================================================
    // PROCESS MANAGEMENT: CREATION
    // =========================================================================

    /**
     * Create a new Process object with common defaults.
     *
     * NOTE: This only creates the object. The worker is NOT started yet.
     * Process starts in 'starting' state.
     *
     * @param opts - Process creation options
     * @returns New Process object in 'starting' state
     */
    private createProcess(opts: {
        parent?: Process;
        cmd: string;
        cwd?: string;
        env?: Record<string, string>;
        args?: string[];
    }): Process {
        return {
            // Identity
            id: this.hal.entropy.uuid(),
            parent: opts.parent?.id ?? '',

            // Worker (set after creation)
            worker: null as unknown as Worker,
            state: 'starting',

            // Execution context
            cmd: opts.cmd,
            cwd: opts.cwd ?? opts.parent?.cwd ?? '/',
            env: opts.parent ? { ...opts.parent.env, ...opts.env } : (opts.env ?? {}),
            args: opts.args ?? [opts.cmd],

            // Handle management
            handles: new Map(),
            nextHandle: 3, // 0, 1, 2 reserved for stdio

            // Child management
            children: new Map(),
            nextPid: 1,

            // Stream management
            activeStreams: new Map(),
            streamPingHandlers: new Map(),
        };
    }

    /**
     * Spawn a child process.
     *
     * ALGORITHM:
     * 1. Create process object
     * 2. Setup stdio (inherit from parent or create pipes)
     * 3. Create and start worker
     * 4. Register in process table
     * 5. Assign PID in parent's namespace
     *
     * @param parent - Parent process
     * @param entry - Entry point path
     * @param opts - Spawn options
     * @returns PID in parent's namespace
     */
    private async spawn(parent: Process, entry: string, opts?: SpawnOpts): Promise<number> {
        const proc = this.createProcess({
            parent,
            cmd: entry,
            cwd: opts?.cwd,
            env: opts?.env,
            args: opts?.args,
        });

        // Setup stdio (inherit from parent by default)
        this.setupStdio(proc, parent, opts);

        // Create and start worker
        proc.worker = await this.spawnWorker(proc, entry);
        proc.state = 'running';

        // Register in process table
        // WHY AFTER WORKER: Process should be queryable only when actually running
        this.processes.register(proc);

        // Assign PID in parent's namespace
        // WHY ATOMIC: No await between incrementing and setting
        const pid = parent.nextPid++;
        parent.children.set(pid, proc.id);

        this.printk('spawn', `${entry} started as PID ${pid} (UUID: ${proc.id.slice(0, 8)})`);

        return pid;
    }

    // =========================================================================
    // PROCESS MANAGEMENT: TERMINATION
    // =========================================================================

    /**
     * Exit the current process (syscall handler).
     *
     * CLEANUP PERFORMED:
     * 1. Set exit code and state to zombie
     * 2. Close all handles
     * 3. Terminate worker
     * 4. Reparent children to init
     * 5. Notify waiters
     *
     * @param proc - Process to exit
     * @param code - Exit code
     * @returns Never returns (throws ProcessExited)
     */
    private async exit(proc: Process, code: number): Promise<never> {
        proc.exitCode = code;
        proc.state = 'zombie';

        this.printk('exit', `${proc.cmd} exiting with code ${code}`);

        // Close all handles
        // WHY AWAIT: Graceful close may need to flush buffers
        for (const [h] of proc.handles) {
            try {
                await this.closeHandle(proc, h);
            } catch (err) {
                // Log but continue - don't let one bad handle prevent cleanup
                this.printk('cleanup', `handle ${h} close failed: ${formatError(err)}`);
            }
        }

        // Terminate worker
        // NOTE: This is synchronous - just sends terminate signal
        proc.worker.terminate();

        // Reparent children to init
        this.processes.reparentOrphans(proc.id);

        // Notify waiters
        this.notifyWaiters(proc);

        // Signal to syscall handler that process has exited
        throw new ProcessExited(code);
    }

    /**
     * Send signal to a process.
     *
     * PERMISSION MODEL:
     * - Process can signal itself
     * - Process can signal its children
     * - Init can signal anyone
     *
     * SIGTERM: Graceful termination with grace period, then SIGKILL
     * SIGKILL: Immediate termination, no cleanup
     *
     * @param caller - Process making the syscall
     * @param targetPid - PID to signal (in caller's namespace)
     * @param signal - Signal number (default SIGTERM)
     */
    private kill(caller: Process, targetPid: number, signal: number = SIGTERM): void {
        // Resolve PID to process
        const target = this.processes.resolvePid(caller, targetPid);
        if (!target) {
            throw new ESRCH(`No such process: ${targetPid}`);
        }

        // Permission check
        // WHY: Prevent arbitrary process from killing system processes
        if (target.parent !== caller.id && target.id !== caller.id) {
            const init = this.processes.getInit();
            if (caller !== init) {
                throw new EPERM(`Cannot signal process ${targetPid}`);
            }
        }

        this.printk('signal', `${caller.cmd} sending signal ${signal} to PID ${targetPid}`);

        if (signal === SIGKILL) {
            // Immediate termination
            this.forceExit(target, 128 + SIGKILL);
        } else if (signal === SIGTERM) {
            // Graceful termination
            this.deliverSignal(target, SIGTERM);

            // Schedule force kill after grace period
            // WHY: Process may not handle SIGTERM; we enforce termination
            this.deps.setTimeout(() => {
                if (target.state === 'running') {
                    this.printk('signal', `Grace period expired for ${target.cmd}, force killing`);
                    this.forceExit(target, 128 + SIGTERM);
                }
            }, TERM_GRACE_MS);
        }
    }

    /**
     * Force exit a process immediately.
     *
     * Unlike graceful exit(), this doesn't await cleanup. Used for:
     * - SIGKILL
     * - Grace period expiry after SIGTERM
     * - Shutdown
     *
     * RACE CONDITION: Multiple calls to forceExit are idempotent.
     * The state=zombie guard ensures cleanup runs only once.
     *
     * @param proc - Process to force exit
     * @param code - Exit code
     */
    private forceExit(proc: Process, code: number): void {
        // Idempotency guard
        if (proc.state === 'zombie') {
            return;
        }

        this.printk('exit', `Force exiting ${proc.cmd} with code ${code}`);

        proc.exitCode = code;
        proc.state = 'zombie';

        // Terminate worker immediately
        proc.worker.terminate();

        // Abort all active streams
        // WHY: Streams may be blocked on await; abort signals them to stop
        for (const abort of proc.activeStreams.values()) {
            abort.abort();
        }
        proc.activeStreams.clear();
        proc.streamPingHandlers.clear();

        // Clean up handles with refcounting
        // NOTE: Fire-and-forget is OK here because:
        // 1. unrefHandle is synchronous for the decrement
        // 2. Async close() is best-effort (we log failures)
        for (const handleId of proc.handles.values()) {
            this.unrefHandle(handleId);
        }
        proc.handles.clear();

        // Release any leased workers
        this.releaseProcessWorkers(proc);

        // Reparent children
        this.processes.reparentOrphans(proc.id);

        // Notify waiters
        this.notifyWaiters(proc);
    }

    // =========================================================================
    // PROCESS MANAGEMENT: WAITING
    // =========================================================================

    /**
     * Wait for a child process to exit.
     *
     * RACE CONDITION MITIGATIONS:
     * 1. Check zombie state first (process may have already exited)
     * 2. Waiter cleanup function removes callback on timeout
     * 3. Clear timeout on successful wait
     *
     * @param caller - Calling process
     * @param pid - PID to wait for
     * @param timeout - Optional timeout in milliseconds
     * @returns Exit status
     * @throws ESRCH if process doesn't exist
     * @throws ECHILD if process is not a child
     * @throws ETIMEDOUT if timeout exceeded
     */
    private async wait(caller: Process, pid: number, timeout?: number): Promise<ExitStatus> {
        const target = this.processes.resolvePid(caller, pid);
        if (!target) {
            throw new ESRCH(`No such process: ${pid}`);
        }

        // Permission check: can only wait on children
        if (target.parent !== caller.id) {
            throw new ECHILD(`Process ${pid} is not a child`);
        }

        // Fast path: already zombie
        if (target.state === 'zombie') {
            const status: ExitStatus = { pid, code: target.exitCode ?? 0 };
            this.reapZombie(caller, pid, target);
            return status;
        }

        // Slow path: wait for exit
        return new Promise<ExitStatus>((resolve, reject) => {
            // Timeout handling
            let timeoutId: ReturnType<typeof setTimeout> | undefined;

            // Create waiter entry with cleanup
            const waiterEntry: WaiterEntry = {
                callback: (status) => {
                    // Clear timeout if set
                    if (timeoutId !== undefined) {
                        this.deps.clearTimeout(timeoutId);
                    }
                    // Reap zombie
                    this.reapZombie(caller, pid, target);
                    resolve({ ...status, pid });
                },
                cleanup: () => {
                    // Remove this waiter from the list
                    const waiters = this.waiters.get(target.id);
                    if (waiters) {
                        const idx = waiters.indexOf(waiterEntry);
                        if (idx !== -1) {
                            waiters.splice(idx, 1);
                        }
                        if (waiters.length === 0) {
                            this.waiters.delete(target.id);
                        }
                    }
                },
            };

            // Add to waiters list
            const waiters = this.waiters.get(target.id) ?? [];
            waiters.push(waiterEntry);
            this.waiters.set(target.id, waiters);

            // Setup timeout if specified
            if (timeout !== undefined && timeout > 0) {
                timeoutId = this.deps.setTimeout(() => {
                    // Clean up waiter before rejecting
                    // RACE FIX: This prevents memory leak if timeout fires
                    waiterEntry.cleanup();
                    reject(new ETIMEDOUT(`wait() timed out after ${timeout}ms`));
                }, timeout);
            }
        });
    }

    /**
     * Notify all processes waiting on a process's exit.
     *
     * @param proc - Process that exited
     */
    private notifyWaiters(proc: Process): void {
        const waiters = this.waiters.get(proc.id);
        if (!waiters) {
            return;
        }

        const status: ExitStatus = {
            pid: 0, // Caller sets correct PID
            code: proc.exitCode ?? 0,
        };

        // Notify all waiters
        for (const waiter of waiters) {
            waiter.callback(status);
        }

        // Clear waiters list
        this.waiters.delete(proc.id);
    }

    /**
     * Reap a zombie process (remove from process table).
     *
     * @param parent - Parent process
     * @param pid - PID in parent's namespace
     * @param zombie - Zombie process to reap
     */
    private reapZombie(parent: Process, pid: number, zombie: Process): void {
        parent.children.delete(pid);
        this.processes.unregister(zombie.id);
        this.printk('reap', `Reaped zombie ${zombie.cmd} (PID ${pid})`);
    }

    // =========================================================================
    // PROCESS MANAGEMENT: PID QUERIES
    // =========================================================================

    /**
     * Get current process ID (in parent's namespace).
     *
     * WHY -1 ON ERROR: Unlike 0 (which could be confused with a valid PID
     * in some contexts), -1 clearly indicates an error condition.
     *
     * @param proc - Current process
     * @returns PID, or 1 for init, or -1 on error
     */
    private getpid(proc: Process): number {
        // Init is always PID 1
        const parent = this.processes.get(proc.parent);
        if (!parent) {
            return 1;
        }

        // Find our PID in parent's children map
        for (const [pid, id] of parent.children) {
            if (id === proc.id) {
                return pid;
            }
        }

        // Should never happen if invariants hold
        this.printk('warn', `getpid: process ${proc.id} not found in parent's children`);
        return -1;
    }

    /**
     * Get parent process ID (in grandparent's namespace).
     *
     * @param proc - Current process
     * @returns Parent PID, or 0 for init (no parent), or 1 if reparented
     */
    private getppid(proc: Process): number {
        // Init has no parent
        if (!proc.parent) {
            return 0;
        }

        const parent = this.processes.get(proc.parent);
        if (!parent) {
            return 1; // Reparented to init
        }

        // Find parent's PID in grandparent's namespace
        const grandparent = this.processes.get(parent.parent);
        if (!grandparent) {
            return 1; // Parent is init
        }

        for (const [pid, id] of grandparent.children) {
            if (id === parent.id) {
                return pid;
            }
        }

        return 1;
    }

    // =========================================================================
    // WORKER AND MESSAGE HANDLING
    // =========================================================================

    /**
     * Spawn a worker for a process.
     *
     * DESIGN: All paths starting with / are VFS paths. The VFS loader:
     * 1. Resolves the path
     * 2. Transpiles TypeScript
     * 3. Bundles dependencies
     * 4. Creates a blob URL
     *
     * The blob URL is revoked after a delay to allow the worker to load.
     *
     * @param proc - Process to create worker for
     * @param entry - Entry point path
     * @returns Worker instance
     */
    private async spawnWorker(proc: Process, entry: string): Promise<Worker> {
        // Bundle the entry point
        const bundle = await this.loader.assembleBundle(entry);
        const workerUrl = this.loader.createBlobURL(bundle);

        // Create worker
        const worker = new Worker(workerUrl, {
            type: 'module',
            env: proc.env,
        });

        // Revoke blob URL after worker loads
        // WHY DELAY: Worker needs time to fetch the blob before we revoke it
        this.deps.setTimeout(() => {
            this.loader.revokeBlobURL(workerUrl);
        }, BLOB_URL_REVOKE_DELAY_MS);

        // Wire up syscall handling
        worker.onmessage = (event: MessageEvent<KernelMessage>) => {
            this.handleMessage(proc, event.data);
        };

        // Handle worker errors
        worker.onerror = (error) => {
            const msg = `Process ${proc.cmd} error: ${error.message}\n`;
            this.hal.console.error(new TextEncoder().encode(msg));
            this.forceExit(proc, 1);
        };

        return worker;
    }

    /**
     * Handle message from process.
     *
     * MESSAGE TYPES:
     * - syscall: Process making a syscall
     * - stream_ping: Progress report for backpressure
     * - stream_cancel: Request to cancel a streaming syscall
     *
     * @param proc - Source process
     * @param msg - Message from process
     */
    private async handleMessage(proc: Process, msg: KernelMessage): Promise<void> {
        // RACE FIX: Check process state before handling
        // A zombie process may still have messages in flight
        if (proc.state === 'zombie') {
            return;
        }

        switch (msg.type) {
            case 'syscall':
                await this.handleSyscall(proc, msg as SyscallRequest);
                break;
            case 'stream_ping':
                this.handleStreamPing(proc, msg.id, msg.processed);
                break;
            case 'stream_cancel':
                this.handleStreamCancel(proc, msg.id);
                break;
        }
    }

    /**
     * Handle syscall request with streaming response and backpressure.
     *
     * STREAMING PROTOCOL:
     * 1. Kernel yields Response objects from syscall handler
     * 2. Each Response is sent via postMessage
     * 3. Consumer sends stream_ping every 100ms with items processed
     * 4. If gap (sent - acked) >= HIGH_WATER, pause yielding
     * 5. Resume when gap <= LOW_WATER
     * 6. If no ping for STALL_TIMEOUT, abort (consumer dead)
     *
     * TERMINAL OPS: ok, error, done, redirect
     * These signal end of stream.
     *
     * @param proc - Process making syscall
     * @param request - Syscall request
     */
    private async handleSyscall(proc: Process, request: SyscallRequest): Promise<void> {
        this.printk('syscall', `${proc.cmd}: ${request.name}`);

        // Initialize stream state
        const state: StreamState = {
            itemsSent: 0,
            itemsAcked: 0,
            lastPingTime: this.deps.now(),
            resumeResolve: null,
            abort: new AbortController(),
        };

        // Register stream for cancellation
        proc.activeStreams.set(request.id, state.abort);

        // Create ping handler
        proc.streamPingHandlers.set(request.id, (processed: number) => {
            state.itemsAcked = processed;
            state.lastPingTime = this.deps.now();

            // Resume if paused and gap is acceptable
            if (state.resumeResolve && (state.itemsSent - state.itemsAcked) <= STREAM_LOW_WATER) {
                state.resumeResolve();
                state.resumeResolve = null;
            }
        });

        try {
            const iterable = this.syscalls.dispatch(proc, request.name, request.args);

            for await (const response of iterable) {
                // Check cancellation
                if (state.abort.signal.aborted) {
                    this.printk('syscall', `${proc.cmd}: ${request.name} -> cancelled`);
                    break;
                }

                // RACE FIX: Check process state after every await
                if (proc.state !== 'running') {
                    this.printk('syscall', `${proc.cmd}: ${request.name} -> process no longer running`);
                    break;
                }

                // Check for stall (consumer unresponsive)
                // Only check after first item - consumer can't ping for items it hasn't received
                if (state.itemsSent > 0) {
                    const stallTime = this.deps.now() - state.lastPingTime;
                    if (stallTime >= STREAM_STALL_TIMEOUT) {
                        this.sendResponse(proc, request.id, {
                            op: 'error',
                            data: { code: 'ETIMEDOUT', message: 'Stream consumer unresponsive' },
                        });
                        this.printk('syscall', `${proc.cmd}: ${request.name} -> timeout (stall: ${stallTime}ms)`);
                        return;
                    }
                }

                // Send response
                this.sendResponse(proc, request.id, response);

                // Terminal ops end the stream
                if (response.op === 'ok' || response.op === 'done' || response.op === 'error' || response.op === 'redirect') {
                    this.printk('syscall', `${proc.cmd}: ${request.name} -> ${response.op}`);
                    return;
                }

                // Track non-terminal items for backpressure
                state.itemsSent++;

                // Reset ping timer on first item
                if (state.itemsSent === 1) {
                    state.lastPingTime = this.deps.now();
                }

                // Backpressure check
                const gap = state.itemsSent - state.itemsAcked;
                if (gap >= STREAM_HIGH_WATER) {
                    this.printk('syscall', `${proc.cmd}: ${request.name} -> backpressure (gap=${gap})`);

                    await new Promise<void>((resolve) => {
                        state.resumeResolve = resolve;

                        // Safety timeout to prevent permanent block
                        this.deps.setTimeout(() => {
                            if (state.resumeResolve === resolve) {
                                resolve();
                                state.resumeResolve = null;
                            }
                        }, STREAM_STALL_TIMEOUT);
                    });

                    // Re-check stall after resume
                    const stallTime = this.deps.now() - state.lastPingTime;
                    if (stallTime >= STREAM_STALL_TIMEOUT) {
                        this.sendResponse(proc, request.id, {
                            op: 'error',
                            data: { code: 'ETIMEDOUT', message: 'Stream consumer unresponsive' },
                        });
                        this.printk('syscall', `${proc.cmd}: ${request.name} -> timeout after backpressure`);
                        return;
                    }
                }
            }
        } catch (error) {
            // Convert uncaught exceptions to error responses
            const err = error as Error & { code?: string };
            this.sendResponse(proc, request.id, {
                op: 'error',
                data: { code: err.code ?? 'EIO', message: err.message },
            });
            this.printk('syscall', `${proc.cmd}: ${request.name} -> error: ${err.code ?? 'EIO'}`);
        } finally {
            // Cleanup stream tracking
            proc.activeStreams.delete(request.id);
            proc.streamPingHandlers.delete(request.id);
        }
    }

    /**
     * Send a response to a process.
     *
     * SAFETY: Catches and logs errors from postMessage.
     * This can happen if worker is terminating.
     *
     * @param proc - Target process
     * @param requestId - Request ID for correlation
     * @param response - Response to send
     */
    private sendResponse(proc: Process, requestId: string, response: Response): void {
        try {
            proc.worker.postMessage({
                type: 'response',
                id: requestId,
                result: response,
            });
        } catch (err) {
            // Worker may be terminating - log but don't throw
            this.printk('warn', `Failed to send response to ${proc.cmd}: ${formatError(err)}`);
        }
    }

    /**
     * Handle stream ping (progress report from consumer).
     */
    private handleStreamPing(proc: Process, requestId: string, processed: number): void {
        const handler = proc.streamPingHandlers.get(requestId);
        if (handler) {
            handler(processed);
        }
    }

    /**
     * Handle stream cancel (consumer wants to stop).
     */
    private handleStreamCancel(proc: Process, requestId: string): void {
        const abort = proc.activeStreams.get(requestId);
        if (abort) {
            abort.abort();
            proc.activeStreams.delete(requestId);
            proc.streamPingHandlers.delete(requestId);
        }
    }

    /**
     * Deliver a signal to a process.
     */
    private deliverSignal(proc: Process, signal: number): void {
        const msg: SignalMessage = {
            type: 'signal',
            signal,
        };
        try {
            proc.worker.postMessage(msg);
        } catch (err) {
            this.printk('warn', `Failed to deliver signal to ${proc.cmd}: ${formatError(err)}`);
        }
    }

    // =========================================================================
    // STDIO SETUP
    // =========================================================================

    /**
     * Setup stdio for init process.
     *
     * Uses ConsoleHandleAdapter for message-based I/O to the console.
     * This is the boundary where Response messages become bytes.
     */
    private async setupInitStdio(init: Process): Promise<void> {
        // stdin (fd 0)
        const stdinAdapter = new ConsoleHandleAdapter(
            this.hal.entropy.uuid(),
            this.hal.console,
            'stdin'
        );
        this.handles.set(stdinAdapter.id, stdinAdapter);
        this.handleRefs.set(stdinAdapter.id, 1);
        init.handles.set(0, stdinAdapter.id);

        // stdout (fd 1)
        const stdoutAdapter = new ConsoleHandleAdapter(
            this.hal.entropy.uuid(),
            this.hal.console,
            'stdout'
        );
        this.handles.set(stdoutAdapter.id, stdoutAdapter);
        this.handleRefs.set(stdoutAdapter.id, 1);
        init.handles.set(1, stdoutAdapter.id);

        // stderr (fd 2)
        const stderrAdapter = new ConsoleHandleAdapter(
            this.hal.entropy.uuid(),
            this.hal.console,
            'stderr'
        );
        this.handles.set(stderrAdapter.id, stderrAdapter);
        this.handleRefs.set(stderrAdapter.id, 1);
        init.handles.set(2, stderrAdapter.id);
    }

    /**
     * Setup stdio for a new process.
     *
     * Inherits file descriptors from parent and increments reference counts.
     *
     * ASSUMPTION: Parent's stdio handles exist.
     * If they don't (shouldn't happen), child runs with missing handles.
     *
     * @param proc - New process
     * @param parent - Parent process
     * @param opts - Spawn options (may override stdio)
     */
    private setupStdio(proc: Process, parent: Process, opts?: SpawnOpts): void {
        // Determine which handles to use
        const stdin = opts?.stdin ?? 0;
        const stdout = opts?.stdout ?? 1;
        const stderr = opts?.stderr ?? 2;

        // stdin
        if (typeof stdin === 'number') {
            const handleId = parent.handles.get(stdin);
            if (handleId) {
                proc.handles.set(0, handleId);
                this.refHandle(handleId);
            } else {
                // LOGGING: Missing handle is unexpected; log for debugging
                this.printk('warn', `Parent missing stdin handle ${stdin}`);
            }
        }
        // TODO: Handle stdin === 'pipe'

        // stdout
        if (typeof stdout === 'number') {
            const handleId = parent.handles.get(stdout);
            if (handleId) {
                proc.handles.set(1, handleId);
                this.refHandle(handleId);
            } else {
                this.printk('warn', `Parent missing stdout handle ${stdout}`);
            }
        }

        // stderr
        if (typeof stderr === 'number') {
            const handleId = parent.handles.get(stderr);
            if (handleId) {
                proc.handles.set(2, handleId);
                this.refHandle(handleId);
            } else {
                this.printk('warn', `Parent missing stderr handle ${stderr}`);
            }
        }
    }

    // =========================================================================
    // HANDLE MANAGEMENT
    // =========================================================================

    /**
     * Get a handle by process-local file descriptor.
     *
     * @param proc - Process
     * @param h - Handle number (fd)
     * @returns Handle or undefined
     */
    getHandle(proc: Process, h: number): Handle | undefined {
        const handleId = proc.handles.get(h);
        if (!handleId) {
            return undefined;
        }
        return this.handles.get(handleId);
    }

    /**
     * Allocate a handle ID and register in process and kernel tables.
     *
     * @param proc - Process
     * @param handle - Handle to allocate
     * @returns File descriptor number
     * @throws EMFILE if too many open handles
     */
    private allocHandle(proc: Process, handle: Handle): number {
        if (proc.handles.size >= MAX_HANDLES) {
            throw new EMFILE('Too many open handles');
        }

        // Register in kernel table
        this.handles.set(handle.id, handle);
        this.handleRefs.set(handle.id, 1);

        // Allocate fd in process
        const h = proc.nextHandle++;
        proc.handles.set(h, handle.id);

        return h;
    }

    /**
     * Increment reference count for a handle.
     *
     * INVARIANT: Handle must exist in handles map.
     */
    private refHandle(handleId: string): void {
        const refs = this.handleRefs.get(handleId) ?? 1;
        this.handleRefs.set(handleId, refs + 1);
    }

    /**
     * Decrement reference count, closing if last reference.
     *
     * DESIGN: Close is async but we don't await it here.
     * Failure is logged but doesn't prevent other cleanup.
     */
    private unrefHandle(handleId: string): void {
        const refs = (this.handleRefs.get(handleId) ?? 1) - 1;

        if (refs <= 0) {
            const handle = this.handles.get(handleId);
            if (handle) {
                handle.close().catch((err) => {
                    this.printk('cleanup', `handle ${handleId} close failed: ${formatError(err)}`);
                });
                this.handles.delete(handleId);
            }
            this.handleRefs.delete(handleId);
        } else {
            this.handleRefs.set(handleId, refs);
        }
    }

    // =========================================================================
    // FILE OPERATIONS
    // =========================================================================

    /**
     * Open a file and allocate handle.
     */
    private async openFile(proc: Process, path: string, flags: OpenFlags): Promise<number> {
        const vfsHandle = await this.vfs.open(path, flags, proc.id);
        const adapter = new FileHandleAdapter(vfsHandle.id, vfsHandle);
        return this.allocHandle(proc, adapter);
    }

    /**
     * Connect TCP or Unix socket and allocate handle.
     */
    private async connectTcp(proc: Process, host: string, port: number): Promise<number> {
        const socket = await this.hal.network.connect(host, port);

        const isUnix = port === 0;
        const description = isUnix
            ? `unix:${host}`
            : `tcp:${socket.stat().remoteAddr}:${socket.stat().remotePort}`;
        const adapter = new SocketHandleAdapter(this.hal.entropy.uuid(), socket, description);
        return this.allocHandle(proc, adapter);
    }

    /**
     * Close a handle.
     */
    private async closeHandle(proc: Process, h: number): Promise<void> {
        const handleId = proc.handles.get(h);
        if (!handleId) {
            throw new EBADF(`Bad file descriptor: ${h}`);
        }

        // Remove from process
        proc.handles.delete(h);

        // Decrement refcount
        this.unrefHandle(handleId);
    }

    /**
     * Create a message pipe.
     *
     * @returns [recvFd, sendFd]
     */
    private createPipe(proc: Process): [number, number] {
        // Check limit (need 2 handles)
        if (proc.handles.size + 2 > MAX_HANDLES) {
            throw new EMFILE('Too many open handles');
        }

        const pipeId = this.hal.entropy.uuid();
        const [recvEnd, sendEnd] = createMessagePipe(pipeId);

        const recvFd = this.allocHandle(proc, recvEnd);
        const sendFd = this.allocHandle(proc, sendEnd);

        return [recvFd, sendFd];
    }

    /**
     * Redirect a handle to point to another handle's resource.
     *
     * @returns Saved handle ID for later restoration
     */
    private redirectHandle(proc: Process, targetH: number, sourceH: number): string {
        const sourceHandleId = proc.handles.get(sourceH);
        if (!sourceHandleId) {
            throw new EBADF(`Bad source file descriptor: ${sourceH}`);
        }

        const savedHandleId = proc.handles.get(targetH);
        if (!savedHandleId) {
            throw new EBADF(`Bad target file descriptor: ${targetH}`);
        }

        // Point target to source's handle
        proc.handles.set(targetH, sourceHandleId);
        this.refHandle(sourceHandleId);

        return savedHandleId;
    }

    /**
     * Restore a handle to its original resource.
     */
    private restoreHandle(proc: Process, targetH: number, savedHandleId: string): void {
        const currentHandleId = proc.handles.get(targetH);
        if (!currentHandleId) {
            throw new EBADF(`Bad file descriptor: ${targetH}`);
        }

        proc.handles.set(targetH, savedHandleId);

        // Decrement refcount on redirected handle
        const refs = (this.handleRefs.get(currentHandleId) ?? 1) - 1;
        if (refs <= 0) {
            this.handleRefs.delete(currentHandleId);
        } else {
            this.handleRefs.set(currentHandleId, refs);
        }
    }

    // =========================================================================
    // PORT OPERATIONS
    // =========================================================================

    /**
     * Create a port and allocate handle.
     */
    private async createPort(proc: Process, type: string, opts: unknown): Promise<number> {
        let port: Port;

        switch (type) {
            case 'tcp:listen': {
                const listenOpts = opts as { port: number; host?: string; backlog?: number } | undefined;
                if (!listenOpts || typeof listenOpts.port !== 'number') {
                    throw new EINVAL('tcp:listen requires port option');
                }

                const listener = await this.hal.network.listen(listenOpts.port, {
                    hostname: listenOpts.host,
                    backlog: listenOpts.backlog,
                });

                const portId = this.hal.entropy.uuid();
                const addr = listener.addr();
                const description = `tcp:listen:${addr.hostname}:${addr.port}`;
                port = new ListenerPort(portId, listener, description);
                break;
            }

            case 'watch': {
                const watchOpts = opts as { pattern: string } | undefined;
                if (!watchOpts || typeof watchOpts.pattern !== 'string') {
                    throw new EINVAL('watch requires pattern option');
                }

                const portId = this.hal.entropy.uuid();
                const description = `watch:${watchOpts.pattern}`;

                const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                    return this.vfs.watch(pattern, proc.id);
                };

                port = new WatchPort(portId, watchOpts.pattern, vfsWatch, description);
                break;
            }

            case 'udp': {
                const udpOpts = opts as { bind: number; address?: string } | undefined;
                if (!udpOpts || typeof udpOpts.bind !== 'number') {
                    throw new EINVAL('udp requires bind option');
                }

                const portId = this.hal.entropy.uuid();
                const description = `udp:${udpOpts.address ?? '0.0.0.0'}:${udpOpts.bind}`;
                port = new UdpPort(portId, udpOpts, description);
                break;
            }

            case 'pubsub': {
                const pubsubOpts = opts as { subscribe?: string | string[] } | undefined;
                const patterns = pubsubOpts?.subscribe
                    ? Array.isArray(pubsubOpts.subscribe)
                        ? pubsubOpts.subscribe
                        : [pubsubOpts.subscribe]
                    : [];

                const portId = this.hal.entropy.uuid();
                const description = patterns.length > 0
                    ? `pubsub:${patterns.join(',')}`
                    : 'pubsub:(send-only)';

                const publishFn = (topic: string, data: Uint8Array | undefined, meta: Record<string, unknown> | undefined, sourcePortId: string) => {
                    this.publishPubsub(topic, data, meta, sourcePortId);
                };

                const unsubscribeFn = () => {
                    const handle = this.handles.get(portId) as PortHandleAdapter | undefined;
                    if (handle) {
                        const p = handle.getPort() as PubsubPort;
                        this.pubsubPorts.delete(p);
                    }
                };

                const pubsubPort = new PubsubPort(portId, patterns, publishFn, unsubscribeFn, description);
                this.pubsubPorts.add(pubsubPort);
                port = pubsubPort;
                break;
            }

            default:
                throw new EINVAL(`Unknown port type: ${type}`);
        }

        const adapter = new PortHandleAdapter(port.id, port, port.description);
        return this.allocHandle(proc, adapter);
    }

    /**
     * Get port from a handle.
     */
    private getPortFromHandle(proc: Process, h: number): Port | undefined {
        const handle = this.getHandle(proc, h);
        if (!handle || handle.type !== 'port') {
            return undefined;
        }
        return (handle as PortHandleAdapter).getPort();
    }

    /**
     * Receive from port handle.
     */
    private async recvPort(proc: Process, h: number): Promise<ProcessPortMessage> {
        const port = this.getPortFromHandle(proc, h);
        if (!port) {
            throw new EBADF(`Bad port: ${h}`);
        }

        const msg = await port.recv();

        // If message contains a socket, wrap it
        if (msg.socket) {
            if (proc.handles.size >= MAX_HANDLES) {
                await msg.socket.close();
                throw new EMFILE('Too many open handles');
            }

            const stat = msg.socket.stat();
            const description = `tcp:${stat.remoteAddr}:${stat.remotePort}`;
            const adapter = new SocketHandleAdapter(this.hal.entropy.uuid(), msg.socket, description);
            const fd = this.allocHandle(proc, adapter);

            return {
                from: msg.from,
                fd,
                meta: msg.meta,
            };
        }

        return {
            from: msg.from,
            data: msg.data,
            meta: msg.meta,
        };
    }

    // =========================================================================
    // CHANNEL OPERATIONS
    // =========================================================================

    /**
     * Open a channel and allocate handle.
     */
    private async openChannel(
        proc: Process,
        proto: string,
        url: string,
        opts?: ChannelOpts
    ): Promise<number> {
        const channel = await this.hal.channel.open(proto, url, opts);
        const adapter = new ChannelHandleAdapter(channel.id, channel, `${channel.proto}:${channel.description}`);
        const h = this.allocHandle(proc, adapter);

        this.printk('channel', `opened ${channel.proto}:${channel.description} as fd ${h}`);
        return h;
    }

    /**
     * Get a channel from a handle.
     */
    private getChannelFromHandle(proc: Process, h: number): Channel | undefined {
        const handle = this.getHandle(proc, h);
        if (!handle || handle.type !== 'channel') {
            return undefined;
        }
        return (handle as ChannelHandleAdapter).getChannel();
    }

    // =========================================================================
    // PUBSUB ROUTING
    // =========================================================================

    /**
     * Publish a message to matching pubsub subscribers.
     */
    private publishPubsub(
        topic: string,
        data: Uint8Array | undefined,
        meta: Record<string, unknown> | undefined,
        sourcePortId: string
    ): void {
        const message = {
            from: topic,
            data,
            meta: {
                ...meta,
                timestamp: this.deps.now(),
            },
        };

        for (const port of this.pubsubPorts) {
            // Don't echo to sender
            if (port.id === sourcePortId) {
                continue;
            }

            // Check pattern match
            for (const pattern of port.getPatterns()) {
                if (matchTopic(pattern, topic)) {
                    port.enqueue(message);
                    break; // Only deliver once per port
                }
            }
        }
    }

    // =========================================================================
    // SERVICE MANAGEMENT
    // =========================================================================

    /**
     * Log a service error.
     */
    private logServiceError(service: string, context: string, err: unknown): void {
        this.hal.console.error(
            new TextEncoder().encode(`service ${service}: ${context}: ${formatError(err)}\n`)
        );
    }

    /**
     * Load services from /etc/services and package directories.
     */
    private async loadServices(): Promise<void> {
        const serviceDirs: string[] = [];

        // Core services
        try {
            await this.vfs.stat('/etc/services', 'kernel');
            serviceDirs.push('/etc/services');
        } catch {
            await this.vfs.mkdir('/etc/services', 'kernel', { recursive: true });
            serviceDirs.push('/etc/services');
        }

        // Package services
        try {
            await this.vfs.stat('/usr', 'kernel');
            for await (const pkg of this.vfs.readdir('/usr', 'kernel')) {
                if (pkg.model !== 'folder') continue;
                const pkgServicesDir = `/usr/${pkg.name}/etc/services`;
                try {
                    await this.vfs.stat(pkgServicesDir, 'kernel');
                    serviceDirs.push(pkgServicesDir);
                } catch {
                    // No services - fine
                }
            }
        } catch {
            // No /usr - fine
        }

        // Load from all directories
        for (const dir of serviceDirs) {
            await this.loadServicesFromDir(dir);
        }
    }

    /**
     * Load services from a directory.
     */
    private async loadServicesFromDir(dir: string): Promise<void> {
        for await (const entry of this.vfs.readdir(dir, 'kernel')) {
            if (!entry.name.endsWith('.json')) continue;

            const serviceName = entry.name.replace(/\.json$/, '');
            const path = `${dir}/${entry.name}`;

            // Skip if already loaded
            if (this.services.has(serviceName)) {
                continue;
            }

            try {
                // Read service definition
                const handle = await this.vfs.open(path, { read: true }, 'kernel');
                const chunks: Uint8Array[] = [];
                while (true) {
                    const chunk = await handle.read(65536);
                    if (chunk.length === 0) break;
                    chunks.push(chunk);
                }
                await handle.close();

                const total = chunks.reduce((sum, c) => sum + c.length, 0);
                const combined = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                    combined.set(chunk, offset);
                    offset += chunk.length;
                }

                const content = new TextDecoder().decode(combined);
                const def = JSON.parse(content) as ServiceDef;

                // Validate handler exists
                const handlerPath = def.handler.endsWith('.ts') ? def.handler : def.handler + '.ts';
                try {
                    await this.vfs.stat(handlerPath, 'kernel');
                } catch {
                    this.logServiceError(serviceName, 'unknown handler', def.handler);
                    continue;
                }

                this.services.set(serviceName, def);
                await this.activateService(serviceName, def);
            } catch (err) {
                this.logServiceError(serviceName, 'load failed', err);
            }
        }
    }

    /**
     * Activate a service based on its definition.
     */
    private async activateService(name: string, def: ServiceDef): Promise<void> {
        const activation = def.activate;

        switch (activation.type) {
            case 'boot':
                await this.spawnServiceHandler(name, def);
                break;

            case 'tcp:listen': {
                const hostname = activation.host ?? '127.0.0.1';
                const listener = await this.hal.network.listen(activation.port, { hostname });

                const portId = this.hal.entropy.uuid();
                const addr = listener.addr();
                const description = `service:${name}:tcp:${addr.hostname}:${addr.port}`;
                const port = new ListenerPort(portId, listener, description);

                this.activationPorts.set(name, port);

                const abort = new AbortController();
                this.activationAborts.set(name, abort);

                this.runActivationLoop(name, def, port, abort.signal, (msg) => {
                    if (msg.socket) {
                        const stat = msg.socket.stat();
                        this.printk('tcp', `${name}: accepted from ${stat.remoteAddr}:${stat.remotePort}`);
                        return {
                            socket: msg.socket,
                            activation: {
                                op: 'tcp',
                                data: {
                                    remoteAddr: stat.remoteAddr,
                                    remotePort: stat.remotePort,
                                    localAddr: stat.localAddr,
                                    localPort: stat.localPort,
                                },
                            },
                        };
                    }
                    return null;
                });
                break;
            }

            case 'pubsub': {
                const portId = this.hal.entropy.uuid();
                const patterns = [activation.topic];
                const description = `service:${name}:pubsub:${activation.topic}`;

                const publishFn = (topic: string, data: Uint8Array | undefined, meta: Record<string, unknown> | undefined, sourcePortId: string) => {
                    this.publishPubsub(topic, data, meta, sourcePortId);
                };
                const unsubscribeFn = () => {
                    this.pubsubPorts.delete(port);
                };

                const port = new PubsubPort(portId, patterns, publishFn, unsubscribeFn, description);
                this.pubsubPorts.add(port);
                this.activationPorts.set(name, port);

                const abort = new AbortController();
                this.activationAborts.set(name, abort);

                this.runActivationLoop(name, def, port, abort.signal, (msg) => ({
                    activation: {
                        op: 'pubsub',
                        data: { topic: msg.from, payload: msg.data },
                    },
                }));
                break;
            }

            case 'watch': {
                const portId = this.hal.entropy.uuid();
                const description = `service:${name}:watch:${activation.pattern}`;

                const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                    return this.vfs.watch(pattern, 'kernel');
                };

                const port = new WatchPort(portId, activation.pattern, vfsWatch, description);
                this.activationPorts.set(name, port);

                const abort = new AbortController();
                this.activationAborts.set(name, abort);

                this.runActivationLoop(name, def, port, abort.signal, (msg) => ({
                    activation: {
                        op: 'watch',
                        data: { path: msg.from, event: msg.meta?.op, content: msg.data },
                    },
                }));
                break;
            }

            case 'udp': {
                const portId = this.hal.entropy.uuid();
                const description = `service:${name}:udp:${activation.host ?? '0.0.0.0'}:${activation.port}`;

                const port = new UdpPort(portId, { bind: activation.port, address: activation.host }, description);
                this.activationPorts.set(name, port);

                const abort = new AbortController();
                this.activationAborts.set(name, abort);

                this.runActivationLoop(name, def, port, abort.signal, (msg) => ({
                    activation: {
                        op: 'udp',
                        data: { from: msg.from, payload: msg.data },
                    },
                }));
                break;
            }
        }
    }

    /**
     * Unified activation loop for services.
     */
    private async runActivationLoop(
        name: string,
        def: ServiceDef,
        port: Port,
        signal: AbortSignal,
        transform: (msg: import('@src/kernel/resource.js').PortMessage) => {
            socket?: import('@src/hal/network.js').Socket;
            activation?: Message;
        } | null
    ): Promise<void> {
        try {
            while (!signal.aborted) {
                const msg = await port.recv();

                if (signal.aborted) {
                    // Cleanup socket if present
                    if (msg.socket) {
                        await msg.socket.close().catch((err) => {
                            this.printk('cleanup', `socket close on abort: ${formatError(err)}`);
                        });
                    }
                    break;
                }

                const input = transform(msg);
                if (input) {
                    this.spawnServiceHandler(name, def, input.socket, input.activation).catch((err) => {
                        this.logServiceError(name, 'spawn failed', err);
                        if (input.socket) {
                            input.socket.close().catch((closeErr) => {
                                this.printk('cleanup', `socket close on error: ${formatError(closeErr)}`);
                            });
                        }
                    });
                }
            }
        } catch (err) {
            if (!signal.aborted) {
                this.logServiceError(name, 'activation loop error', err);
            }
        }
    }

    /**
     * Spawn a service handler process.
     */
    private async spawnServiceHandler(
        name: string,
        def: ServiceDef,
        socket?: import('@src/hal/network.js').Socket,
        activation?: Message
    ): Promise<void> {
        const entry = def.handler.endsWith('.ts') ? def.handler : def.handler + '.ts';
        const proc = this.createProcess({ cmd: def.handler });

        proc.activationMessage = activation;

        // Setup stdio
        if (socket) {
            const stat = socket.stat();
            const description = `tcp:${stat.remoteAddr}:${stat.remotePort}`;
            const adapter = new SocketHandleAdapter(this.hal.entropy.uuid(), socket, description);
            this.handles.set(adapter.id, adapter);
            this.handleRefs.set(adapter.id, 3);
            proc.handles.set(0, adapter.id);
            proc.handles.set(1, adapter.id);
            proc.handles.set(2, adapter.id);
        } else if (def.io) {
            await this.setupServiceIO(proc, def);
        } else {
            await this.setupServiceStdio(proc, 0);
            await this.setupServiceStdio(proc, 1);
            await this.setupServiceStdio(proc, 2);
        }

        this.printk('spawn', `${name}: spawning worker for ${entry}`);
        proc.worker = await this.spawnWorker(proc, entry);
        proc.state = 'running';
        this.printk('spawn', `${name}: worker started (${proc.id.slice(0, 8)})`);

        this.processes.register(proc);
    }

    /**
     * Setup a stdio handle to console for services.
     */
    private async setupServiceStdio(proc: Process, h: number): Promise<void> {
        const flags = h === 0 ? { read: true } : { write: true };
        const vfsHandle = await this.vfs.open(CONSOLE_PATH, flags, 'kernel');
        const adapter = new FileHandleAdapter(vfsHandle.id, vfsHandle);
        this.handles.set(adapter.id, adapter);
        this.handleRefs.set(adapter.id, 1);
        proc.handles.set(h, adapter.id);
    }

    /**
     * Create handle from IO source config.
     */
    private async createIOSourceHandle(source: IOSource, proc: Process): Promise<Handle> {
        switch (source.type) {
            case 'console': {
                const vfsHandle = await this.vfs.open(CONSOLE_PATH, { read: true }, 'kernel');
                return new FileHandleAdapter(vfsHandle.id, vfsHandle);
            }
            case 'file': {
                const vfsHandle = await this.vfs.open(source.path, { read: true }, 'kernel');
                return new FileHandleAdapter(vfsHandle.id, vfsHandle);
            }
            case 'null': {
                return {
                    id: this.hal.entropy.uuid(),
                    type: 'file' as const,
                    description: '/dev/null',
                    closed: false,
                    async *exec() { yield respond.done(); },
                    async close() {},
                };
            }
            case 'pubsub': {
                const patterns = Array.isArray(source.subscribe)
                    ? source.subscribe
                    : [source.subscribe];
                const portId = this.hal.entropy.uuid();
                const description = `pubsub:${patterns.join(',')}`;

                const publishFn = (topic: string, data: Uint8Array | undefined, meta: Record<string, unknown> | undefined, sourcePortId: string) => {
                    this.publishPubsub(topic, data, meta, sourcePortId);
                };
                const unsubscribeFn = () => {
                    this.pubsubPorts.delete(port);
                };

                const port = new PubsubPort(portId, patterns, publishFn, unsubscribeFn, description);
                this.pubsubPorts.add(port);

                return new PortHandleAdapter(portId, port, description);
            }
            case 'watch': {
                const portId = this.hal.entropy.uuid();
                const description = `watch:${source.pattern}`;

                const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                    return this.vfs.watch(pattern, proc.id);
                };

                const port = new WatchPort(portId, source.pattern, vfsWatch, description);
                return new PortHandleAdapter(portId, port, description);
            }
            case 'udp': {
                const portId = this.hal.entropy.uuid();
                const description = `udp:${source.address ?? '0.0.0.0'}:${source.bind}`;
                const port = new UdpPort(portId, { bind: source.bind, address: source.address }, description);
                return new PortHandleAdapter(portId, port, description);
            }
        }
    }

    /**
     * Create handle from IO target config.
     */
    private async createIOTargetHandle(target: IOTarget): Promise<Handle> {
        switch (target.type) {
            case 'console': {
                const vfsHandle = await this.vfs.open(CONSOLE_PATH, { write: true }, 'kernel');
                return new FileHandleAdapter(vfsHandle.id, vfsHandle);
            }
            case 'file': {
                const flags = {
                    write: true,
                    create: target.flags?.create ?? true,
                    append: target.flags?.append ?? false,
                };
                const vfsHandle = await this.vfs.open(target.path, flags, 'kernel');
                return new FileHandleAdapter(vfsHandle.id, vfsHandle);
            }
            case 'null': {
                return {
                    id: this.hal.entropy.uuid(),
                    type: 'file' as const,
                    description: '/dev/null',
                    closed: false,
                    async *exec() { yield respond.ok(); },
                    async close() {},
                };
            }
        }
    }

    /**
     * Setup service I/O using ProcessIOHandle.
     */
    private async setupServiceIO(proc: Process, def: ServiceDef): Promise<void> {
        const io = def.io ?? {};

        // stdin
        const stdinSource = io.stdin
            ? await this.createIOSourceHandle(io.stdin, proc)
            : await this.createIOSourceHandle({ type: 'console' }, proc);

        const stdinHandle = new ProcessIOHandle(
            this.hal.entropy.uuid(),
            `stdin:${proc.cmd}`,
            { source: stdinSource }
        );
        this.handles.set(stdinHandle.id, stdinHandle);
        this.handleRefs.set(stdinHandle.id, 1);
        proc.handles.set(0, stdinHandle.id);

        // stdout
        const stdoutTarget = io.stdout
            ? await this.createIOTargetHandle(io.stdout)
            : await this.createIOTargetHandle({ type: 'console' });

        const stdoutHandle = new ProcessIOHandle(
            this.hal.entropy.uuid(),
            `stdout:${proc.cmd}`,
            { target: stdoutTarget }
        );
        this.handles.set(stdoutHandle.id, stdoutHandle);
        this.handleRefs.set(stdoutHandle.id, 1);
        proc.handles.set(1, stdoutHandle.id);

        // stderr
        const stderrTarget = io.stderr
            ? await this.createIOTargetHandle(io.stderr)
            : await this.createIOTargetHandle({ type: 'console' });

        const stderrHandle = new ProcessIOHandle(
            this.hal.entropy.uuid(),
            `stderr:${proc.cmd}`,
            { target: stderrTarget }
        );
        this.handles.set(stderrHandle.id, stderrHandle);
        this.handleRefs.set(stderrHandle.id, 1);
        proc.handles.set(2, stderrHandle.id);
    }

    // =========================================================================
    // WORKER POOL SYSCALLS
    // =========================================================================

    /**
     * Lease a worker from a pool.
     */
    private async leaseWorker(proc: Process, pool?: string): Promise<string> {
        const worker = await this.poolManager.lease(pool);

        let procWorkers = this.leasedWorkers.get(proc.id);
        if (!procWorkers) {
            procWorkers = new Map();
            this.leasedWorkers.set(proc.id, procWorkers);
        }
        procWorkers.set(worker.id, worker);

        return worker.id;
    }

    /**
     * Load a script into a leased worker.
     */
    private async workerLoad(proc: Process, workerId: string, path: string): Promise<void> {
        const worker = this.getLeasedWorker(proc, workerId);
        await worker.load(path);
    }

    /**
     * Send message to a leased worker.
     */
    private async workerSend(proc: Process, workerId: string, msg: unknown): Promise<void> {
        const worker = this.getLeasedWorker(proc, workerId);
        await worker.send(msg);
    }

    /**
     * Receive message from a leased worker.
     */
    private async workerRecv(proc: Process, workerId: string): Promise<unknown> {
        const worker = this.getLeasedWorker(proc, workerId);
        return worker.recv();
    }

    /**
     * Release a leased worker.
     */
    private async workerRelease(proc: Process, workerId: string): Promise<void> {
        const procWorkers = this.leasedWorkers.get(proc.id);
        if (!procWorkers) {
            throw new EBADF(`No workers leased by process ${proc.id}`);
        }

        const worker = procWorkers.get(workerId);
        if (!worker) {
            throw new EBADF(`Worker not found: ${workerId}`);
        }

        await worker.release();
        procWorkers.delete(workerId);

        if (procWorkers.size === 0) {
            this.leasedWorkers.delete(proc.id);
        }
    }

    /**
     * Get a leased worker by ID.
     */
    private getLeasedWorker(proc: Process, workerId: string): LeasedWorker {
        const procWorkers = this.leasedWorkers.get(proc.id);
        if (!procWorkers) {
            throw new EBADF(`No workers leased by process ${proc.id}`);
        }

        const worker = procWorkers.get(workerId);
        if (!worker) {
            throw new EBADF(`Worker not found: ${workerId}`);
        }

        return worker;
    }

    /**
     * Release all workers when a process exits.
     */
    private releaseProcessWorkers(proc: Process): void {
        const procWorkers = this.leasedWorkers.get(proc.id);
        if (procWorkers) {
            for (const [workerId, worker] of procWorkers.entries()) {
                worker.release().catch((err) => {
                    this.printk('cleanup', `worker ${workerId} release failed: ${formatError(err)}`);
                });
            }
            this.leasedWorkers.delete(proc.id);
        }
    }

    // =========================================================================
    // MOUNT OPERATIONS
    // =========================================================================

    /**
     * Mount a source to a target path (syscall handler).
     *
     * ALGORITHM:
     * 1. Find matching policy rule
     * 2. If no rule matches, deny (EPERM)
     * 3. If rule has requireGrant, check ACL on target
     * 4. Resolve source to model and mount
     *
     * @param proc - Calling process
     * @param source - Mount source (e.g., 'host:/path', 's3://bucket')
     * @param target - Mount target path
     * @param opts - Mount options
     * @throws EPERM if no policy rule allows the mount
     * @throws EACCES if requireGrant check fails
     */
    private async mountFs(
        proc: Process,
        source: string,
        target: string,
        opts?: Record<string, unknown>
    ): Promise<void> {
        const caller = proc.id;

        // Find matching policy rule
        const rule = this.findMountPolicyRule(caller, source, target);
        if (!rule) {
            this.printk('mount', `DENIED: ${caller.slice(0, 8)} mount ${source} -> ${target}`);
            throw new EPERM(`Mount policy denies: ${source} -> ${target}`);
        }

        this.printk('mount', `Policy match: ${rule.description ?? 'unnamed rule'}`);

        // Check grant if required
        if (rule.requireGrant) {
            try {
                // Check if caller has required grant on target directory
                // This uses VFS ACL system
                await this.vfs.stat(target, caller);
                // TODO: Need proper ACL check for specific grant, not just stat
                // For now, stat success means read access, which is insufficient
                // This is a placeholder until VFS.checkAccess is exposed
            } catch (err) {
                const error = err as Error & { code?: string };
                if (error.code === 'ENOENT') {
                    // Target doesn't exist - that's ok, we'll create it
                } else if (error.code === 'EACCES') {
                    throw new EACCES(`Mount requires '${rule.requireGrant}' grant on ${target}`);
                }
            }
        }

        // Parse source and mount
        if (source.startsWith('host:')) {
            const hostPath = source.slice(5); // Remove 'host:' prefix
            this.vfs.mountHost(target, hostPath, opts as import('@src/vfs/mounts/host.js').HostMountOptions);
            this.printk('mount', `Mounted host:${hostPath} -> ${target}`);
        } else if (source === 'tmpfs') {
            // tmpfs is not yet supported via syscall - VFS doesn't expose getModel
            // For now, throw ENOTSUP. Users can create directories in /tmp instead.
            throw new ENOTSUP('tmpfs mounts not yet supported via syscall');
        } else {
            // Future: s3://, gcs://, etc.
            throw new EINVAL(`Unknown mount source type: ${source}`);
        }
    }

    /**
     * Unmount a path (syscall handler).
     *
     * @param proc - Calling process
     * @param target - Path to unmount
     * @throws EPERM if no policy rule allows the unmount
     * @throws EINVAL if target is not mounted
     */
    private async umountFs(proc: Process, target: string): Promise<void> {
        const caller = proc.id;

        // Use same policy check as mount (if you can mount, you can unmount)
        // Source is '*' for unmount since we don't know what was mounted
        const rule = this.findMountPolicyRule(caller, '*', target);
        if (!rule) {
            this.printk('mount', `DENIED: ${caller.slice(0, 8)} umount ${target}`);
            throw new EPERM(`Mount policy denies umount: ${target}`);
        }

        // Try to unmount (VFS handles the actual unmount)
        this.vfs.unmount(target);
        this.vfs.unmountHost(target);

        this.printk('mount', `Unmounted ${target}`);
    }

    /**
     * Find a matching mount policy rule.
     *
     * Rules are evaluated in order; first match wins.
     *
     * @param caller - Caller UUID
     * @param source - Mount source
     * @param target - Mount target
     * @returns Matching rule or null
     */
    private findMountPolicyRule(
        caller: string,
        source: string,
        target: string
    ): MountPolicyRule | null {
        for (const rule of this.mountPolicy.rules) {
            if (this.matchesMountRule(rule, caller, source, target)) {
                return rule;
            }
        }
        return null;
    }

    /**
     * Check if a mount operation matches a policy rule.
     *
     * @param rule - Policy rule to check
     * @param caller - Caller UUID
     * @param source - Mount source
     * @param target - Mount target
     * @returns True if rule matches
     */
    private matchesMountRule(
        rule: MountPolicyRule,
        caller: string,
        source: string,
        target: string
    ): boolean {
        // Check caller pattern
        if (rule.caller !== '*' && rule.caller !== caller) {
            return false;
        }

        // Check source pattern
        if (!this.matchesPattern(rule.source, source)) {
            return false;
        }

        // Check target pattern (with substitutions)
        const expandedTarget = rule.target
            .replace('{caller}', caller);
        // TODO: Add {tenant} substitution when auth context is available

        if (!this.matchesPattern(expandedTarget, target)) {
            return false;
        }

        return true;
    }

    /**
     * Match a value against a glob-like pattern.
     *
     * Supports:
     * - '*' matches any single path component
     * - '**' matches any number of path components
     * - Exact match
     *
     * @param pattern - Pattern to match against
     * @param value - Value to match
     * @returns True if matches
     */
    private matchesPattern(pattern: string, value: string): boolean {
        // Exact match or wildcard all
        if (pattern === '*' || pattern === '**' || pattern === value) {
            return true;
        }

        // Simple glob matching
        // Convert pattern to regex
        const regexStr = pattern
            .replace(/\*\*/g, '<<<GLOBSTAR>>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<<GLOBSTAR>>>/g, '.*');

        const regex = new RegExp(`^${regexStr}$`);
        return regex.test(value);
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get process table.
     * TESTING: Allows tests to inspect process state.
     */
    getProcessTable(): ProcessTable {
        return this.processes;
    }

    /**
     * Check if booted.
     */
    isBooted(): boolean {
        return this.booted;
    }

    /**
     * Get loaded services.
     * TESTING: Allows tests to verify service loading.
     */
    getServices(): Map<string, ServiceDef> {
        return this.services;
    }

    /**
     * Get handle count.
     * TESTING: Allows tests to verify no handle leaks.
     */
    getHandleCount(): number {
        return this.handles.size;
    }

    /**
     * Get waiter count for a process.
     * TESTING: Allows tests to verify waiter cleanup.
     */
    getWaiterCount(processId: string): number {
        return this.waiters.get(processId)?.length ?? 0;
    }
}
