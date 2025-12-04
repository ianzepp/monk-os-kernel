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
import type { ExitStatus, BootEnv } from '@src/kernel/types.js';
import { SIGTERM, SIGKILL, TERM_GRACE_MS } from '@src/kernel/types.js';
import { poll } from '@src/kernel/poll.js';
import { ProcessTable } from '@src/kernel/process-table.js';
import type { Handle } from '@src/kernel/handle.js';
import { SyscallDispatcher, registerSyscalls } from '@src/kernel/syscalls.js';
import { EBUSY } from '@src/kernel/errors.js';
import type { Port } from '@src/kernel/resource.js';
import { PubsubPort } from '@src/kernel/resource.js';
import type { ServiceDef } from '@src/kernel/services.js';
import { loadMounts } from '@src/kernel/mounts.js';
import { copyRomToVfs } from '@src/kernel/boot.js';
import { VFSLoader } from '@src/kernel/loader.js';
import { PoolManager, type LeasedWorker } from '@src/kernel/pool.js';
// Extracted kernel functions (used by boot, shutdown, spawnExternal)
import { createProcess } from '@src/kernel/kernel/create-process.js';
import { forceExit } from '@src/kernel/kernel/force-exit.js';
import { deliverSignal } from '@src/kernel/kernel/deliver-signal.js';
import { spawnWorker } from '@src/kernel/kernel/spawn-worker.js';
import { setupInitStdio } from '@src/kernel/kernel/setup-init-stdio.js';
import { loadServices } from '@src/kernel/kernel/load-services.js';
import { printk } from '@src/kernel/kernel/printk.js';
import { formatError } from '@src/kernel/kernel/format-error.js';


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
    readonly hal: HAL;

    /**
     * Virtual File System - provides:
     * - Path resolution
     * - File/folder operations
     * - Device files (/dev/*)
     * - Process info (/proc/*)
     */
    readonly vfs: VFS;

    /**
     * Injectable dependencies for testability.
     * Production uses real implementations; tests can mock.
     */
    readonly deps: KernelDeps;

    // =========================================================================
    // PROCESS MANAGEMENT
    // =========================================================================

    /**
     * Process table - maps UUID to Process objects.
     * INVARIANT: All running/starting processes are in this table.
     * Zombies remain until reaped by parent's wait().
     */
    readonly processes: ProcessTable;

    /**
     * Wait queue - processes blocked on wait() syscall.
     *
     * Key: target process UUID
     * Value: list of waiters (callbacks + cleanup functions)
     *
     * RACE FIX: Each waiter has a cleanup function that removes it from
     * the list. This is called on timeout to prevent memory leaks.
     */
    readonly waiters: Map<string, WaiterEntry[]> = new Map();

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
    readonly handles: Map<string, Handle> = new Map();

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
    readonly handleRefs: Map<string, number> = new Map();

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
    readonly syscalls: SyscallDispatcher;

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
    readonly pubsubPorts: Set<PubsubPort> = new Set();

    // =========================================================================
    // SERVICE MANAGEMENT
    // =========================================================================

    /**
     * Loaded service definitions by name.
     * Services are loaded from /etc/services/*.json at boot.
     */
    readonly services: Map<string, ServiceDef> = new Map();

    /**
     * Activation ports by service name.
     * For tcp:listen, udp, watch, pubsub activation types.
     */
    readonly activationPorts: Map<string, Port> = new Map();

    /**
     * Abort controllers for service activation loops.
     * Used to cleanly stop activation loops during shutdown.
     */
    readonly activationAborts: Map<string, AbortController> = new Map();

    // =========================================================================
    // WORKER POOLS
    // =========================================================================

    /**
     * VFS module loader - bundles TypeScript for Worker execution.
     */
    readonly loader: VFSLoader;

    /**
     * Worker pool manager - provides pooled workers for compute tasks.
     */
    readonly poolManager: PoolManager;

    /**
     * Leased workers by process.
     * Outer map: process UUID -> inner map
     * Inner map: worker UUID -> LeasedWorker
     *
     * WHY NESTED: A process can lease multiple workers. On process exit,
     * we release all workers leased by that process.
     */
    readonly leasedWorkers: Map<string, Map<string, LeasedWorker>> = new Map();

    // =========================================================================
    // MOUNT POLICY
    // =========================================================================

    /**
     * Mount policy rules (static, defined in code).
     *
     * Determines who can mount what sources to which targets.
     * Rules are evaluated in order; first match wins.
     */
    readonly mountPolicy: MountPolicy = DEFAULT_MOUNT_POLICY;

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
    booted = false;

    /**
     * Debug logging flag.
     * When true, printk() outputs to console.
     * Set via boot environment debug flag.
     */
    debugEnabled = false;

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
        registerSyscalls(this);
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
        printk(this, 'boot', 'Starting kernel boot sequence');

        // ---------------------------------------------------------------------
        // PHASE 1: VFS INITIALIZATION
        // ---------------------------------------------------------------------

        printk(this, 'boot', 'Initializing VFS');
        await this.vfs.init();

        // ---------------------------------------------------------------------
        // PHASE 1.5: STANDARD DIRECTORY STRUCTURE
        // Create all core directories defensively before anything else runs.
        // This ensures a consistent filesystem layout regardless of ROM contents.
        // ---------------------------------------------------------------------

        printk(this, 'boot', 'Creating standard directory structure');
        await this.createStandardDirectories();

        // ---------------------------------------------------------------------
        // PHASE 2: ROM COPY
        // Copy bundled userspace code into VFS with proper UUIDs and ACLs
        // ---------------------------------------------------------------------

        const romPath = env.romPath ?? './rom';
        printk(this, 'boot', `Copying ROM to VFS from: ${romPath}`);
        await copyRomToVfs({ vfs: this.vfs }, romPath);

        // ---------------------------------------------------------------------
        // PHASE 3: MOUNTS, POLICY, AND POOLS
        // ---------------------------------------------------------------------

        printk(this, 'boot', 'Loading mounts');
        await loadMounts({ vfs: this.vfs, hal: this.hal, loader: this.loader });

        printk(this, 'boot', 'Loading pool configuration');
        await this.poolManager.loadConfig(this.vfs);

        // ---------------------------------------------------------------------
        // PHASE 4: INIT PROCESS CREATION
        // Init must be created first to be PID 1
        // ---------------------------------------------------------------------

        printk(this, 'boot', `Creating init process: ${env.initPath}`);
        const init = createProcess(this, {
            cmd: env.initPath,
            env: env.env,
            args: env.initArgs,
        });
        this.processes.register(init);

        // ---------------------------------------------------------------------
        // PHASE 5: SERVICE ACTIVATION
        // Services are loaded after init exists but before it starts
        // This allows boot-activated services to run alongside init
        // ---------------------------------------------------------------------

        printk(this, 'boot', 'Loading services');
        await loadServices(this);

        // ---------------------------------------------------------------------
        // PHASE 6: INIT STARTUP
        // ---------------------------------------------------------------------

        printk(this, 'boot', 'Setting up init stdio');
        await setupInitStdio(this, init);

        printk(this, 'boot', 'Starting init worker');
        init.worker = await spawnWorker(this, init, env.initPath);
        init.state = 'running';

        // Boot complete
        this.booted = true;
        printk(this, 'boot', 'Kernel boot complete');
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
                printk(this, 'boot', `Created directory: ${dir}`);
            } catch (err) {
                // EEXIST is fine - directory already exists (idempotent)
                const error = err as Error & { code?: string };
                if (error.code !== 'EEXIST') {
                    printk(this, 'warn', `Failed to create ${dir}: ${formatError(err)}`);
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

        printk(this, 'shutdown', 'Starting kernel shutdown');

        // ---------------------------------------------------------------------
        // PHASE 1: GRACEFUL TERMINATION
        // Send SIGTERM and wait for processes to exit gracefully
        // ---------------------------------------------------------------------

        const init = this.processes.getInit();
        let runningCount = 0;

        for (const proc of this.processes.all()) {
            // Skip init - it's killed last
            if (proc !== init && proc.state === 'running') {
                deliverSignal(this, proc, SIGTERM);
                runningCount++;
            }
        }

        printk(this, 'shutdown', `Sent SIGTERM to ${runningCount} processes`);

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
                printk(this, 'shutdown', `Force killing process: ${proc.cmd}`);
                forceExit(this, proc, 128 + SIGKILL);
            }
        }

        // ---------------------------------------------------------------------
        // PHASE 3: SERVICE CLEANUP
        // Stop activation loops and close ports
        // ---------------------------------------------------------------------

        printk(this, 'shutdown', 'Stopping service activation loops');
        for (const abort of this.activationAborts.values()) {
            abort.abort();
        }

        printk(this, 'shutdown', 'Closing activation ports');
        for (const [name, port] of this.activationPorts) {
            await port.close().catch((err: unknown) => {
                printk(this, 'cleanup', `activation port ${name} close failed: ${formatError(err)}`);
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

        printk(this, 'shutdown', 'Shutting down worker pools');
        this.poolManager.shutdown();
        this.leasedWorkers.clear();

        this.booted = false;
        printk(this, 'shutdown', 'Kernel shutdown complete');
    }

    // =========================================================================
    // PROCESS MANAGEMENT (PUBLIC)
    // =========================================================================

    /**
     * Spawn a process from outside the kernel.
     *
     * This is the fundamental primitive for the host (OS layer) to create
     * kernel processes. The process runs with stdio connected to the console.
     *
     * @param entry - VFS path to the script to run
     * @param opts - Spawn options (args, env, cwd)
     * @returns Handle to manage the spawned process
     */
    async spawnExternal(
        entry: string,
        opts?: import('@src/kernel/types.js').ExternalSpawnOpts
    ): Promise<import('@src/kernel/types.js').ExternalProcessHandle> {
        if (!this.booted) {
            throw new Error('Kernel not booted');
        }

        // Normalize entry path
        const entryPath = entry.endsWith('.ts') ? entry : entry + '.ts';

        // Create process with no parent (like init)
        const proc = createProcess(this, {
            cmd: entry,
            cwd: opts?.cwd ?? '/',
            env: opts?.env ?? {},
            args: opts?.args ?? [entry],
        });

        // Setup stdio to console (like init)
        await setupInitStdio(this, proc);

        // Spawn worker
        printk(this, 'spawn', `external: spawning ${entryPath}`);
        proc.worker = await spawnWorker(this, proc, entryPath);
        proc.state = 'running';

        // Register in process table
        this.processes.register(proc);
        printk(this, 'spawn', `external: started ${entryPath} (${proc.id.slice(0, 8)})`);

        // Create handle for caller
        const processId = proc.id;
        const kernel = this;

        return {
            id: processId,

            async kill(signal = SIGTERM): Promise<void> {
                const target = kernel.processes.get(processId);
                if (!target || target.state === 'zombie') {
                    return; // Already dead
                }
                deliverSignal(kernel, target, signal);
            },

            wait(): Promise<{ code: number }> {
                return new Promise((resolve) => {
                    const target = kernel.processes.get(processId);

                    // Already dead?
                    if (!target) {
                        resolve({ code: -1 });
                        return;
                    }
                    if (target.state === 'zombie') {
                        resolve({ code: target.exitCode ?? 0 });
                        return;
                    }

                    // Wait for exit
                    const waiterEntry = {
                        callback: (status: ExitStatus) => {
                            resolve({ code: status.code });
                        },
                        cleanup: () => {
                            const waiters = kernel.waiters.get(processId);
                            if (waiters) {
                                const idx = waiters.indexOf(waiterEntry);
                                if (idx !== -1) {
                                    waiters.splice(idx, 1);
                                }
                            }
                        },
                    };

                    const waiters = kernel.waiters.get(processId) ?? [];
                    waiters.push(waiterEntry);
                    kernel.waiters.set(processId, waiters);
                });
            },
        };
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
