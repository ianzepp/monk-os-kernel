/**
 * OS - The Public API for Monk OS
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The OS class is the single entry point for external applications to interact
 * with Monk OS. It orchestrates the boot sequence, provides syscall wrappers,
 * and manages the lifecycle of all subsystems.
 *
 * Subsystem initialization order (boot):
 *   HAL → EMS → VFS → Kernel → Dispatcher → Gateway → Init Process
 *
 * Subsystem teardown order (shutdown):
 *   Gateway → Kernel → VFS → EMS → HAL
 *
 * The OS class itself is stateless beyond configuration - all persistent state
 * lives in the subsystems (EMS for entities, VFS for files, Kernel for processes).
 *
 * STATE MACHINE
 * =============
 *
 *   [created] ──boot()──▶ [booting] ──success──▶ [booted]
 *       │                     │                     │
 *       │                     │ failure             │ shutdown()
 *       │                     ▼                     ▼
 *       │                 [failed]              [shutdown]
 *       │                                           │
 *       └───────────────────────────────────────────┘
 *                      (can boot again after shutdown)
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: booted === true implies all subsystems (__hal, __ems, __vfs, __kernel,
 *        __dispatcher) are non-null and initialized.
 *        VIOLATED BY: Partial boot failure without cleanup, concurrent shutdown.
 *
 * INV-2: booted === false implies either never booted OR fully shut down.
 *        VIOLATED BY: Boot failure leaving partial state.
 *
 * INV-3: Syscalls require booted === true and init process exists.
 *        VIOLATED BY: Calling syscall() before boot() or after shutdown().
 *
 * INV-4: Aliases are safe to modify at any time (no cross-thread access).
 *        VIOLATED BY: Nothing - aliases are main-thread only.
 *
 * CONCURRENCY MODEL
 * =================
 * The OS class runs entirely in the main thread. All async operations are
 * cooperative (single-threaded with await points). The subsystems (especially
 * Kernel) manage worker threads internally.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Boot guard - booted flag checked at start of boot() to prevent
 *       concurrent boot attempts.
 *
 * RC-2: Shutdown idempotence - shutdown() is safe to call multiple times
 *       (early return if not booted).
 *
 * RC-3: Boot failure cleanup - if boot() fails partway, all initialized
 *       subsystems are cleaned up before re-throwing.
 *
 * MEMORY MANAGEMENT
 * =================
 * Subsystem references are held in private fields. On shutdown, subsystems
 * are shut down in reverse order and references set to null. The OS instance
 * can be rebooted after shutdown.
 *
 * @module os
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HAL, HALConfig } from '@src/hal/index.js';
import { BunHAL, EINVAL, EBUSY } from '@src/hal/index.js';
import { VFS } from '@src/vfs/vfs.js';
import { Kernel } from '@src/kernel/kernel.js';
import type { ServiceDef } from '@src/kernel/services.js';
import { activateService } from '@src/kernel/kernel/activate-service.js';
import type { Process } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';
import { fromCode } from '@src/hal/errors.js';
import type { OSConfig, BootOpts, ExecOpts, OSEvents, OSEventName } from './types.js';
import { EMS } from '@src/ems/ems.js';
import type { EntityOps } from '@src/ems/entity-ops.js';
import { Auth } from '@src/auth/index.js';
import { SyscallDispatcher } from '@src/syscall/index.js';
import { Gateway } from '@src/gateway/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Standard directories created during boot.
 *
 * WHY: Provides a consistent filesystem layout matching Unix conventions.
 * Created before ROM copy so ROM files can override if needed.
 */
const STANDARD_DIRECTORIES = [
    '/app',      // Application data and state
    '/bin',      // User commands
    '/ems',      // Entity filesystem mount
    '/etc',      // System configuration
    '/home',     // User home directories
    '/svc',      // Service definitions
    '/tmp',      // Temporary files
    '/usr',      // User programs
    '/var',      // Variable data
    '/var/log',  // Log files
    '/vol',      // Mounted volumes
];

/**
 * Default init process path.
 *
 * WHY: /svc/init.ts is the conventional location for the init process,
 * matching systemd-style service directory organization.
 */
const DEFAULT_INIT_PATH = '/svc/init.ts';

/**
 * Default ROM source path on host filesystem.
 *
 * WHY: ./rom is the conventional location for userspace code that gets
 * copied into the VFS at boot time.
 */
const DEFAULT_ROM_PATH = './rom';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * OS class - main entry point for Monk OS.
 *
 * Provides the public API for booting, syscalls, and lifecycle management.
 */
export class OS {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    /**
     * OS configuration provided at construction.
     *
     * WHY: Stored for reference during boot() and for getEnv().
     * INVARIANT: Never null after construction.
     */
    private config: OSConfig;

    /**
     * Path aliases for convenient path resolution.
     *
     * WHY: Allows '@app' → '/vol/app' style shortcuts in user code.
     * Can be modified at any time via alias().
     */
    private aliases: Map<string, string> = new Map();

    // =========================================================================
    // SUBSYSTEM REFERENCES
    // =========================================================================

    /**
     * Hardware Abstraction Layer.
     *
     * WHY: Provides storage backend (memory/sqlite/postgres) and low-level I/O.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __hal: HAL | null = null;

    /**
     * Entity Management System.
     *
     * WHY: Provides entity storage, versioning, and queries.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __ems: EMS | null = null;

    /**
     * Authentication subsystem.
     *
     * WHY: Handles identity ("who are you?") for external clients.
     * Sets proc.user/session/expires on successful auth:token.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __auth: Auth | null = null;

    /**
     * Virtual File System.
     *
     * WHY: Provides POSIX-like filesystem abstraction over EMS entities.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __vfs: VFS | null = null;

    /**
     * Process kernel.
     *
     * WHY: Manages process lifecycle, workers, and IPC.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __kernel: Kernel | null = null;

    /**
     * Syscall dispatcher.
     *
     * WHY: Routes syscalls to appropriate handlers and manages response streams.
     * Sits outside kernel to separate concerns.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __dispatcher: SyscallDispatcher | null = null;

    /**
     * External syscall gateway.
     *
     * WHY: Provides Unix socket interface for external apps (os-shell, displayd).
     * Runs in kernel context for direct syscall execution without IPC overhead.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __gateway: Gateway | null = null;

    // =========================================================================
    // LIFECYCLE STATE
    // =========================================================================

    /**
     * Boot state flag.
     *
     * WHY: Guards against double-boot and enables syscall validation.
     * INVARIANT: true only when all subsystems are initialized.
     */
    private booted = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new OS instance.
     *
     * @param config - Optional configuration
     */
    constructor(config?: OSConfig) {
        this.config = config ?? {};

        // Initialize aliases from config
        if (config?.aliases) {
            for (const [name, aliasPath] of Object.entries(config.aliases)) {
                this.aliases.set(name, aliasPath);
            }
        }
    }

    // =========================================================================
    // CONFIGURATION API
    // =========================================================================

    /**
     * Add or update a path alias.
     *
     * WHY: Enables '@app' → '/vol/app' style shortcuts. Can be called
     * before or after boot.
     *
     * @param name - Alias name (e.g., '@app')
     * @param aliasPath - Target path (e.g., '/vol/app')
     * @returns this for chaining
     */
    alias(name: string, aliasPath: string): this {
        this.aliases.set(name, aliasPath);

        return this;
    }

    /**
     * Register a lifecycle event listener.
     *
     * @deprecated Lifecycle events are not currently supported.
     * @throws EINVAL always
     */
    on<K extends OSEventName>(_event: K, _callback: OSEvents[K]): this {
        throw new EINVAL('Lifecycle events not supported');
    }

    /**
     * Resolve a path, expanding any aliases.
     *
     * WHY: Centralizes alias expansion so all path-accepting methods
     * can support aliases uniformly.
     *
     * @param inputPath - Path that may contain an alias prefix
     * @returns Resolved path with alias expanded
     */
    resolvePath(inputPath: string): string {
        for (const [alias, target] of this.aliases) {
            if (inputPath === alias) {
                return target;
            }

            if (inputPath.startsWith(alias + '/')) {
                return target + inputPath.slice(alias.length);
            }
        }

        return inputPath;
    }

    // =========================================================================
    // SYSCALL API
    // =========================================================================

    /**
     * Get the init process for syscall context.
     *
     * WHY: External syscalls execute in the context of PID 1 (init).
     * This provides proper process identity for permission checks
     * and resource tracking.
     *
     * @throws EINVAL if OS not booted or init process not found
     */
    private getInitProcess(): Process {
        if (!this.__kernel) {
            throw new EINVAL('OS not booted');
        }

        const init = this.__kernel.processes.getInit();

        if (!init) {
            throw new EINVAL('Init process not found');
        }

        return init;
    }

    /**
     * Make a syscall to the kernel.
     *
     * Low-level interface for direct kernel communication.
     * Executes in the context of the init process (PID 1).
     *
     * ALGORITHM:
     * 1. Get init process for syscall context
     * 2. Dispatch syscall through dispatcher
     * 3. Collect response stream into result
     * 4. Return single value (ok) or array (items)
     *
     * @param name - Syscall name (e.g., 'file:open', 'ems:select')
     * @param args - Syscall arguments
     * @returns Unwrapped result (single value or array of items)
     * @throws Error from syscall if response.op === 'error'
     *
     * @example
     * ```typescript
     * // Single-value syscall
     * const fd = await os.syscall<number>('file:open', '/etc/config.json', { read: true });
     *
     * // Streaming syscall (items collected into array)
     * const users = await os.syscall<User[]>('ems:select', 'User', { where: { active: true } });
     * ```
     */
    async syscall<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
        // SAFETY: getInitProcess() throws if not booted
        const init = this.getInitProcess();

        // SAFETY: __dispatcher is non-null when booted (INV-1)
        const stream = this.__dispatcher!.dispatch(init, name, args);

        // Collect response - handles both single-value and streaming syscalls
        const items: unknown[] = [];
        let singleResult: unknown = undefined;
        let hasOk = false;

        for await (const response of stream) {
            // RACE FIX: Check boot state after each await - shutdown could occur
            if (!this.booted) {
                throw new EINVAL('OS shutdown during syscall');
            }

            if (response.op === 'ok') {
                singleResult = response.data;
                hasOk = true;
                break;
            }

            if (response.op === 'item') {
                items.push(response.data);
                continue;
            }

            if (response.op === 'done') {
                break;
            }

            if (response.op === 'error') {
                const err = response.data as { code: string; message: string };

                throw fromCode(err.code, err.message);
            }

            // data, event, progress - collect for special cases
            if (response.op === 'data' && response.bytes) {
                items.push(response.bytes);
            }
        }

        // Return single value or collected items
        if (hasOk) {
            return singleResult as T;
        }

        return items as T;
    }

    /**
     * Make a syscall and return the raw response stream.
     *
     * WHY: Some syscalls need streaming (progress events, large data).
     * This method exposes the raw stream for full control.
     *
     * @param name - Syscall name
     * @param args - Syscall arguments
     * @returns AsyncIterable of Response objects
     */
    syscallStream(name: string, ...args: unknown[]): AsyncIterable<Response> {
        // SAFETY: getInitProcess() throws if not booted
        const init = this.getInitProcess();

        // SAFETY: __dispatcher is non-null when booted (INV-1)
        return this.__dispatcher!.dispatch(init, name, args);
    }

    // =========================================================================
    // DOMAIN SYSCALL WRAPPERS
    // =========================================================================

    /**
     * Entity Management System syscall.
     *
     * @param method - EMS method (select, create, update, delete, revert, expire)
     * @param args - Method arguments
     * @returns Syscall result
     */
    async ems<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.syscall<T>(`ems:${method}`, ...args);
    }

    /**
     * Virtual File System syscall.
     *
     * @param method - VFS method (open, close, read, write, stat, mkdir, etc.)
     * @param args - Method arguments
     * @returns Syscall result
     */
    async vfs<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.syscall<T>(`file:${method}`, ...args);
    }

    /**
     * Process syscall.
     *
     * @param method - Process method (spawn, kill, wait, getpid, etc.)
     * @param args - Method arguments
     * @returns Syscall result
     */
    async process<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.syscall<T>(`proc:${method}`, ...args);
    }

    // =========================================================================
    // SYSCALL ALIASES
    // =========================================================================

    /**
     * Alias for vfs() - file system operations.
     */
    file<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.vfs<T>(method, ...args);
    }

    /**
     * Alias for ems() - entity operations.
     */
    entity<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.ems<T>(method, ...args);
    }

    // =========================================================================
    // CONVENIENCE HELPERS
    // =========================================================================

    /**
     * Spawn a new process.
     *
     * @param cmd - Path to script (aliases resolved)
     * @param opts - Spawn options
     * @returns Process ID
     */
    async spawn(
        cmd: string,
        opts?: { args?: string[]; env?: Record<string, string>; cwd?: string },
    ): Promise<number> {
        const resolved = this.resolvePath(cmd);

        return this.process<number>('spawn', resolved, opts);
    }

    /**
     * Kill a process.
     *
     * @param pid - Process ID
     * @param signal - Signal number (default: 15 = SIGTERM)
     */
    async kill(pid: number, signal = 15): Promise<void> {
        return this.process<void>('kill', pid, signal);
    }

    /**
     * Mount a filesystem.
     *
     * @param type - Mount type ('host' for host filesystem)
     * @param source - Source path (host path for 'host' type)
     * @param target - Target path in VFS (aliases resolved)
     * @param opts - Mount options
     */
    async mount(
        type: string,
        source: string,
        target: string,
        opts?: Record<string, unknown>,
    ): Promise<void> {
        const resolved = this.resolvePath(target);
        const fullSource = `${type}:${source}`;

        return this.syscall<void>('fs:mount', fullSource, resolved, opts);
    }

    /**
     * Unmount a filesystem.
     *
     * @param target - Target path to unmount (aliases resolved)
     */
    async unmount(target: string): Promise<void> {
        const resolved = this.resolvePath(target);

        return this.syscall<void>('fs:umount', resolved);
    }

    /**
     * Copy from host filesystem to VFS.
     *
     * WHY: Enables copying ROM files and host directories into VFS
     * during boot or at runtime.
     *
     * @param hostSource - Source path on host filesystem
     * @param vfsTarget - Target path in VFS (aliases resolved)
     */
    async copy(hostSource: string, vfsTarget: string): Promise<void> {
        const resolved = this.resolvePath(vfsTarget);
        const stat = await fs.stat(hostSource);

        if (stat.isDirectory()) {
            await this.copyDir(hostSource, resolved);
        }
        else {
            await this.copyFile(hostSource, resolved);
        }
    }

    /**
     * Read a file as raw bytes.
     *
     * @param filePath - File path (aliases resolved)
     * @returns File contents as Uint8Array
     */
    async read(filePath: string): Promise<Uint8Array> {
        const resolved = this.resolvePath(filePath);
        const fd = await this.vfs<number>('open', resolved, { read: true });

        try {
            // Collect all data chunks
            const chunks = await this.syscall<Uint8Array[]>('file:read', fd);

            // Concatenate chunks
            if (chunks.length === 0) {
                return new Uint8Array(0);
            }

            if (chunks.length === 1) {
                return chunks[0]!;
            }

            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;

            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }

            return result;
        }
        finally {
            await this.vfs('close', fd);
        }
    }

    /**
     * Read a file as text.
     *
     * @param filePath - File path (aliases resolved)
     * @param encoding - Text encoding (default: 'utf-8')
     * @returns File contents as string
     */
    async text(filePath: string, encoding = 'utf-8'): Promise<string> {
        const bytes = await this.read(filePath);

        // WHY cast: TextDecoder accepts any valid encoding string, but TypeScript
        // has a strict Encoding type. We trust the caller to provide valid encodings.
        return new TextDecoder(encoding as 'utf-8').decode(bytes);
    }

    // =========================================================================
    // SERVICE MANAGEMENT
    // =========================================================================

    /**
     * Service management operations.
     *
     * WHY: Provides a high-level API for service lifecycle management
     * without requiring direct kernel access.
     *
     * @param action - Action to perform (start, stop, restart, status, list)
     * @param nameOrPid - Service name or PID (required for all except 'list')
     * @returns Action result
     */
    async service(action: string, nameOrPid?: string | number): Promise<unknown> {
        if (!this.__kernel) {
            throw new EINVAL('OS not booted');
        }

        const services = this.__kernel.getServices();

        switch (action) {
            case 'list':
                return Array.from(services.values());

            case 'status': {
                if (!nameOrPid) {
                    throw new EINVAL('Service name required');
                }

                const svc = services.get(String(nameOrPid));

                if (!svc) {
                    throw new EINVAL(`Service not found: ${nameOrPid}`);
                }

                return svc;
            }

            case 'start': {
                if (!nameOrPid) {
                    throw new EINVAL('Service name required');
                }

                const name = String(nameOrPid);
                const def = services.get(name);

                if (!def) {
                    throw new EINVAL(`Service not found: ${name}`);
                }

                // RACE: Check-then-act on activation state
                // WHY: Acceptable because activateService() is idempotent
                if (this.__kernel.activationPorts.has(name) || this.__kernel.activationAborts.has(name)) {
                    throw new EINVAL(`Service already running: ${name}`);
                }

                await activateService(this.__kernel, name, def);

                return { started: name };
            }

            case 'stop': {
                if (!nameOrPid) {
                    throw new EINVAL('Service name required');
                }

                const name = String(nameOrPid);

                // Abort activation loop if running
                const abort = this.__kernel.activationAborts.get(name);

                if (abort) {
                    abort.abort();
                    this.__kernel.activationAborts.delete(name);
                }

                // Close activation port if exists
                const port = this.__kernel.activationPorts.get(name);

                if (port) {
                    await port.close();
                    this.__kernel.activationPorts.delete(name);
                }

                return { stopped: name };
            }

            case 'restart': {
                if (!nameOrPid) {
                    throw new EINVAL('Service name required');
                }

                await this.service('stop', nameOrPid);
                await this.service('start', nameOrPid);

                return { restarted: String(nameOrPid) };
            }

            default:
                throw new EINVAL(`Unknown service action: ${action}`);
        }
    }

    // =========================================================================
    // LIFECYCLE: BOOT
    // =========================================================================

    /**
     * Boot the OS.
     *
     * Initializes all subsystems in order and starts the init process.
     * For standalone mode, use exec() instead.
     *
     * ALGORITHM:
     * 1. HAL (hardware abstraction)
     * 2. EMS (entity management)
     * 3. VFS (virtual filesystem)
     * 4. Standard directories
     * 5. ROM copy (userspace code)
     * 6. Kernel + Dispatcher
     * 7. Init process
     *
     * RACE CONDITION:
     * Uses booted flag to prevent concurrent boot attempts.
     * On failure, cleans up any initialized subsystems.
     *
     * @param opts - Optional boot options
     * @throws EBUSY if already booted
     * @throws Error from any subsystem initialization
     */
    async boot(opts?: BootOpts): Promise<void> {
        // RC-1: Prevent concurrent boot
        if (this.booted) {
            throw new EBUSY('OS already booted');
        }

        const debug = opts?.debug ?? this.config.debug;

        try {
            // 1. HAL
            this.__hal = new BunHAL(this.buildHALConfig());
            await this.__hal.init();

            // 2. EMS
            this.__ems = new EMS(this.__hal);
            await this.__ems.init();

            // 3. Auth
            // WHY default true: Phase 0 has no auth:login, so users can't authenticate yet.
            // Tests and production can set allowAnonymous: false when ready.
            this.__auth = new Auth(this.__hal, {
                allowAnonymous: this.config.allowAnonymous ?? true,
            });
            await this.__auth.init();

            // 4. VFS
            this.__vfs = new VFS(this.__hal, this.__ems);
            await this.__vfs.init();

            // 5. Standard directories
            await this.createStandardDirectories();

            // 6. ROM copy (userspace code)
            const romPath = opts?.romPath ?? this.config.romPath ?? DEFAULT_ROM_PATH;

            try {
                await this.copy(romPath, '/');
            }
            catch (err) {
                // EDGE: ROM directory may not exist in tests
                const error = err as NodeJS.ErrnoException;

                if (error.code !== 'ENOENT') {
                    throw err;
                }
            }

            // 7. Kernel + Dispatcher
            this.__kernel = new Kernel(this.__hal, this.__ems, this.__vfs);

            this.__dispatcher = new SyscallDispatcher(
                this.__kernel,
                this.__vfs,
                this.__ems,
                this.__hal,
                this.__auth,
            );

            // Wire dispatcher's message handler to kernel
            // WHY: Kernel creates workers, but syscall layer handles messages
            this.__kernel.onWorkerMessage = async (worker, msg) => {
                await this.__dispatcher!.onWorkerMessage(worker, msg);
            };

            // 8. Gateway (external syscall interface)
            const socketPath = this.config.env?.MONK_SOCKET ?? '/tmp/monk.sock';

            this.__gateway = new Gateway(
                this.__dispatcher,
                this.__kernel,
                this.__hal,
            );

            await this.__gateway.listen(socketPath);

            // 9. Init process
            const initPath = opts?.main ? this.resolvePath(opts.main) : DEFAULT_INIT_PATH;

            await this.__kernel.boot({
                initPath,
                initArgs: [initPath],
                env: this.config.env ?? {
                    HOME: '/',
                    USER: 'root',
                },
                debug,
            });

            // RC-3: Only set booted after full success
            this.booted = true;
        }
        catch (err) {
            // RC-3: Clean up on failure to maintain INV-2
            await this.cleanupOnBootFailure();
            throw err;
        }
    }

    /**
     * Execute the OS in standalone mode.
     *
     * Boots the OS and blocks until a shutdown signal (SIGINT/SIGTERM).
     * This is the entry point for `bun run start`.
     *
     * @param opts - Optional exec options
     * @returns Exit code (0 for clean shutdown)
     */
    async exec(opts?: ExecOpts): Promise<number> {
        await this.boot({ main: opts?.main });

        // Create shutdown promise that resolves on signal
        const shutdownPromise = new Promise<number>(resolve => {
            const handleShutdown = async (signal: string) => {
                console.log(`\nReceived ${signal}, shutting down...`);
                await this.shutdown();
                resolve(0);
            };

            process.on('SIGINT', () => handleShutdown('SIGINT'));
            process.on('SIGTERM', () => handleShutdown('SIGTERM'));
        });

        console.log('Monk OS running. Press Ctrl+C to stop.');

        return shutdownPromise;
    }

    // =========================================================================
    // LIFECYCLE: SHUTDOWN
    // =========================================================================

    /**
     * Shutdown the OS gracefully.
     *
     * Shuts down subsystems in reverse boot order:
     * Kernel → VFS → EMS → HAL
     *
     * RACE CONDITION:
     * RC-2: Safe to call multiple times (idempotent via booted check).
     */
    async shutdown(): Promise<void> {
        // RC-2: Idempotent - safe to call if not booted
        if (!this.booted) {
            return;
        }

        // Mark as not booted first to fail any in-flight syscalls
        this.booted = false;

        // Shutdown in reverse order: Gateway → Kernel → VFS → Auth → EMS → HAL
        if (this.__gateway) {
            await this.__gateway.shutdown();
        }

        if (this.__kernel?.isBooted()) {
            await this.__kernel.shutdown();
        }

        if (this.__vfs) {
            await this.__vfs.shutdown();
        }

        if (this.__auth) {
            await this.__auth.shutdown();
        }

        if (this.__ems) {
            await this.__ems.shutdown();
        }

        if (this.__hal) {
            await this.__hal.shutdown();
        }

        // Clear references
        this.__gateway = null;
        this.__dispatcher = null;
        this.__kernel = null;
        this.__vfs = null;
        this.__auth = null;
        this.__ems = null;
        this.__hal = null;
    }

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    /**
     * Check if the OS is booted.
     */
    isBooted(): boolean {
        return this.booted;
    }

    /**
     * Get the HAL instance.
     *
     * WHY: Needed for testing and advanced use cases.
     * @throws EINVAL if OS not booted
     */
    getHAL(): HAL {
        if (!this.__hal) {
            throw new EINVAL('OS not booted');
        }

        return this.__hal;
    }

    /**
     * Get the VFS instance.
     *
     * WHY: Needed for testing and advanced use cases.
     * @throws EINVAL if OS not booted
     */
    getVFS(): VFS {
        if (!this.__vfs) {
            throw new EINVAL('OS not booted');
        }

        return this.__vfs;
    }

    /**
     * Get the Kernel instance.
     *
     * WHY: Needed for testing and advanced use cases.
     * @throws EINVAL if OS not booted
     */
    getKernel(): Kernel {
        if (!this.__kernel) {
            throw new EINVAL('OS not booted');
        }

        return this.__kernel;
    }

    /**
     * Get the EMS instance.
     *
     * WHY: Needed for testing and advanced use cases.
     * @throws EINVAL if OS not booted
     */
    getEMS(): EMS {
        if (!this.__ems) {
            throw new EINVAL('OS not booted');
        }

        return this.__ems;
    }

    /**
     * Get the EntityOps instance (for EntityAPI).
     *
     * @throws EINVAL if OS not booted
     */
    getEntityOps(): EntityOps {
        if (!this.__ems) {
            throw new EINVAL('OS not booted');
        }

        return this.__ems.ops;
    }

    /**
     * Get active services.
     *
     * @returns Service map, or empty map if kernel not booted
     */
    getServices(): Map<string, ServiceDef> {
        if (!this.__kernel?.isBooted()) {
            return new Map();
        }

        return this.__kernel.getServices();
    }

    /**
     * Get the OS environment variables.
     */
    getEnv(): Record<string, string> {
        return this.config.env ?? {};
    }

    // =========================================================================
    // TESTING HELPERS
    // =========================================================================

    /**
     * Get count of registered aliases.
     *
     * TESTING: Allows tests to verify alias registration.
     */
    getAliasCount(): number {
        return this.aliases.size;
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Build HAL configuration from OS config.
     *
     * WHY: Translates user-friendly OSConfig.storage into HALConfig format.
     */
    private buildHALConfig(): HALConfig {
        const storage = this.config.storage;

        if (!storage || storage.type === 'memory') {
            return { storage: { type: 'memory' } };
        }

        if (storage.type === 'sqlite') {
            return {
                storage: {
                    type: 'sqlite',
                    path: storage.path ?? '.data/monk.db',
                },
            };
        }

        if (storage.type === 'postgres') {
            if (!storage.url) {
                throw new EINVAL('PostgreSQL storage requires url');
            }

            return {
                storage: {
                    type: 'postgres',
                    url: storage.url,
                },
            };
        }

        return { storage: { type: 'memory' } };
    }

    /**
     * Create standard OS directories.
     *
     * WHY: Provides consistent filesystem layout before ROM copy.
     * Errors other than EEXIST are logged but not fatal.
     */
    private async createStandardDirectories(): Promise<void> {
        if (!this.__vfs) {
            return;
        }

        for (const dir of STANDARD_DIRECTORIES) {
            try {
                await this.__vfs.mkdir(dir, 'kernel', { recursive: true });
            }
            catch (err) {
                const error = err as Error & { code?: string };

                // EEXIST is fine - directory already exists
                if (error.code !== 'EEXIST') {
                    // SAFETY: Log but don't fail - some dirs may not be creatable
                    console.warn(`Failed to create ${dir}: ${error.message}`);
                }
            }
        }
    }

    /**
     * Copy a single file from host to VFS.
     *
     * WHY: Uses VFS directly instead of syscalls to support being called
     * during boot before the kernel is initialized.
     */
    private async copyFile(hostPath: string, vfsPath: string): Promise<void> {
        const vfsInst = this.__vfs;

        if (!vfsInst) {
            throw new EINVAL('VFS not initialized');
        }

        // Ensure parent directory exists
        const parent = vfsPath.substring(0, vfsPath.lastIndexOf('/')) || '/';

        try {
            await vfsInst.stat(parent, 'kernel');
        }
        catch {
            await vfsInst.mkdir(parent, 'kernel', { recursive: true });
        }

        // Read from host
        const content = await fs.readFile(hostPath);

        // Write to VFS using handle API
        const handle = await vfsInst.open(
            vfsPath,
            { write: true, create: true, truncate: true },
            'kernel',
        );

        try {
            await handle.write(new Uint8Array(content));
        }
        finally {
            await handle.close();
        }
    }

    /**
     * Recursively copy a directory from host to VFS.
     *
     * WHY: Uses VFS directly instead of syscalls to support being called
     * during boot before the kernel is initialized.
     */
    private async copyDir(hostPath: string, vfsPath: string): Promise<void> {
        const vfsInst = this.__vfs;

        if (!vfsInst) {
            throw new EINVAL('VFS not initialized');
        }

        // Create target directory
        try {
            await vfsInst.stat(vfsPath, 'kernel');
        }
        catch {
            await vfsInst.mkdir(vfsPath, 'kernel', { recursive: true });
        }

        // Read directory entries
        const entries = await fs.readdir(hostPath, { withFileTypes: true });

        for (const entry of entries) {
            const srcPath = path.join(hostPath, entry.name);
            const dstPath = `${vfsPath}/${entry.name}`;

            if (entry.isDirectory()) {
                await this.copyDir(srcPath, dstPath);
            }
            else if (entry.isFile()) {
                await this.copyFile(srcPath, dstPath);
            }
            // Skip symlinks, sockets, etc. for now
        }
    }

    /**
     * Clean up subsystems after boot failure.
     *
     * WHY: Maintains INV-2 (booted === false means clean state).
     * Called from boot() catch block.
     */
    private async cleanupOnBootFailure(): Promise<void> {
        // Shutdown in reverse order, ignoring errors
        if (this.__gateway) {
            try {
                await this.__gateway.shutdown();
            }
            catch {
                // Ignore cleanup errors
            }
        }

        if (this.__kernel?.isBooted()) {
            try {
                await this.__kernel.shutdown();
            }
            catch {
                // Ignore cleanup errors
            }
        }

        if (this.__vfs) {
            try {
                await this.__vfs.shutdown();
            }
            catch {
                // Ignore cleanup errors
            }
        }

        if (this.__auth) {
            try {
                await this.__auth.shutdown();
            }
            catch {
                // Ignore cleanup errors
            }
        }

        if (this.__ems) {
            try {
                await this.__ems.shutdown();
            }
            catch {
                // Ignore cleanup errors
            }
        }

        if (this.__hal) {
            try {
                await this.__hal.shutdown();
            }
            catch {
                // Ignore cleanup errors
            }
        }

        // Clear references
        this.__gateway = null;
        this.__dispatcher = null;
        this.__kernel = null;
        this.__vfs = null;
        this.__auth = null;
        this.__ems = null;
        this.__hal = null;
    }
}
