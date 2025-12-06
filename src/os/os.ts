/**
 * OS - The public API for Monk OS
 *
 * External applications use this class to boot and interact with Monk OS.
 * Wraps HAL, VFS, and Kernel into a single cohesive interface.
 *
 * @see planning/OS_BOOT_EXEC.md for the full specification
 */

import type { HAL, HALConfig } from '@src/hal/index.js';
import { BunHAL, EINVAL, EBUSY } from '@src/hal/index.js';
import { VFS } from '@src/vfs/vfs.js';
import { Kernel } from '@src/kernel/kernel.js';
import type { ServiceDef } from '@src/kernel/services.js';
import { activateService } from '@src/kernel/kernel/activate-service.js';
import type { Process } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';
import { fromCode } from '@src/hal/errors.js';
import type { OSConfig, BootOpts, ExecOpts, OSEvents, OSEventName, PackageOpts } from './types.js';
import { PackageAPI } from './pkg.js';
import { EMS } from '@src/ems/ems.js';
import type { EntityOps } from '@src/ems/entity-ops.js';

/**
 * Type for storing event listeners
 */
type EventListeners = {
    [K in OSEventName]: Array<OSEvents[K]>;
};

/**
 * OS class - main entry point for Monk OS
 */
export class OS {
    private config: OSConfig;
    private hal: HAL | null = null;
    private _ems: EMS | null = null;
    private _vfs: VFS | null = null;
    private kernel: Kernel | null = null;
    private booted = false;

    // Path aliases
    private aliases: Map<string, string> = new Map();

    // Lifecycle event listeners
    private listeners: EventListeners = {
        hal: [],
        ems: [],
        vfs: [],
        kernel: [],
        boot: [],
        shutdown: [],
    };

    /**
     * Package API for managing OS packages.
     *
     * WHY KEPT: Package installation is a complex host-side operation
     * that doesn't map to simple syscalls.
     */
    readonly pkg: PackageAPI;

    constructor(config?: OSConfig) {
        this.pkg = new PackageAPI(this);
        this.config = config ?? {};

        // Initialize aliases from config
        if (config?.aliases) {
            for (const [name, path] of Object.entries(config.aliases)) {
                this.aliases.set(name, path);
            }
        }

        // Queue packages from config
        if (config?.packages) {
            for (const spec of config.packages) {
                if (typeof spec === 'string') {
                    this.pkg.queue(spec);
                }
                else {
                    this.pkg.queue(spec.name, spec.opts);
                }
            }
        }
    }

    /**
     * Add or update a path alias.
     *
     * @param name - Alias name (e.g., '@app')
     * @param path - Target path (e.g., '/vol/app')
     * @returns this for chaining
     */
    alias(name: string, path: string): this {
        this.aliases.set(name, path);

        return this;
    }

    /**
     * Install a package (pre-boot).
     *
     * Queues the package for installation during boot.
     * For post-boot installation, use `os.pkg.install()`.
     *
     * @param npmName - npm package name (e.g., '@monk-api/httpd')
     * @param opts - Installation options
     * @returns this for chaining
     *
     * @example
     * ```typescript
     * const os = new OS()
     *   .install('@monk-api/httpd')
     *   .install('@monk-api/redis', { config: { port: 6379 } });
     *
     * await os.boot();
     * ```
     */
    install(npmName: string, opts?: PackageOpts): this {
        if (this.booted) {
            throw new EINVAL(
                'Cannot use os.install() after boot. Use os.pkg.install() instead.',
            );
        }

        this.pkg.queue(npmName, opts);

        return this;
    }

    /**
     * Register a lifecycle event listener.
     *
     * Listeners are called during boot() at the appropriate stage.
     * All callbacks receive the OS instance for accessing public APIs.
     *
     * @param event - Event name ('hal', 'vfs', 'kernel', 'boot', 'shutdown')
     * @param callback - Function to call when event fires (receives OS instance)
     * @returns this for chaining
     *
     * @example
     * ```typescript
     * const os = new OS()
     *   .on('vfs', (os) => {
     *     // Mount host directories before kernel starts
     *     os.fs.mount('./src', '/vol/app');
     *   })
     *   .on('boot', (os) => {
     *     console.log('OS fully booted');
     *   });
     *
     * await os.boot({ main: '/vol/app/init.ts' });
     * ```
     */
    on<K extends OSEventName>(event: K, callback: OSEvents[K]): this {
        this.listeners[event].push(callback);

        return this;
    }

    /**
     * Resolve a path, expanding any aliases.
     */
    resolvePath(path: string): string {
        // Check if path starts with an alias
        for (const [alias, target] of this.aliases) {
            if (path === alias) {
                return target;
            }

            if (path.startsWith(alias + '/')) {
                return target + path.slice(alias.length);
            }
        }

        return path;
    }

    // =========================================================================
    // SYSCALL API
    // =========================================================================

    /**
     * Get the init process for syscall context.
     *
     * WHY INIT: External syscalls execute in the context of PID 1.
     * This provides proper process identity for permission checks
     * and resource tracking.
     */
    private getInitProcess(): Process {
        if (!this.kernel) {
            throw new EINVAL('OS not booted');
        }

        const init = this.kernel.processes.getInit();

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
     * @param name - Syscall name (e.g., 'file:open', 'ems:select')
     * @param args - Syscall arguments
     * @returns Unwrapped result (single value or array of items)
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
        const init = this.getInitProcess();
        const stream = this.kernel!.syscalls.dispatch(init, name, args);

        // Collect response - handles both single-value and streaming syscalls
        const items: unknown[] = [];
        let singleResult: unknown = undefined;
        let hasOk = false;

        for await (const response of stream) {
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
     * Use this for syscalls where you need full control over
     * response processing (progress events, streaming data, etc.).
     *
     * @param name - Syscall name
     * @param args - Syscall arguments
     * @returns AsyncIterable of Response objects
     */
    syscallStream(name: string, ...args: unknown[]): AsyncIterable<Response> {
        const init = this.getInitProcess();

        return this.kernel!.syscalls.dispatch(init, name, args);
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
     *
     * @example
     * ```typescript
     * // Select users
     * const users = await os.ems<User[]>('select', 'User', { where: { active: true } });
     *
     * // Create a user
     * const user = await os.ems<User>('create', 'User', { name: 'Alice' });
     * ```
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
     *
     * @example
     * ```typescript
     * // Open a file
     * const fd = await os.vfs<number>('open', '/etc/config.json', { read: true });
     *
     * // Get file stats
     * const stat = await os.vfs<Stat>('stat', '/etc/config.json');
     * ```
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
     *
     * @example
     * ```typescript
     * // Spawn a process
     * const pid = await os.process<number>('spawn', '/bin/worker.ts', { args: ['--port', '9000'] });
     *
     * // Kill a process
     * await os.process('kill', pid, 15);
     * ```
     */
    async process<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.syscall<T>(`proc:${method}`, ...args);
    }

    // =========================================================================
    // ALIASES
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
     * @param path - Path to script (aliases resolved)
     * @param opts - Spawn options
     * @returns Process ID
     */
    async spawn(path: string, opts?: { args?: string[]; env?: Record<string, string>; cwd?: string }): Promise<number> {
        const resolved = this.resolvePath(path);

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
     *
     * @example
     * ```typescript
     * // Mount host directory
     * await os.mount('host', './src', '/app');
     *
     * // Mount with options
     * await os.mount('host', '/data', '/mnt/data', { readonly: true });
     * ```
     */
    async mount(type: string, source: string, target: string, opts?: Record<string, unknown>): Promise<void> {
        const resolved = this.resolvePath(target);
        const fullSource = `${type}:${source}`;

        return this.syscall<void>('fs:mount', fullSource, resolved, opts);
    }

    /**
     * Unmount a filesystem.
     *
     * @param target - Target path to unmount (aliases resolved)
     *
     * @example
     * ```typescript
     * await os.unmount('/app');
     * ```
     */
    async unmount(target: string): Promise<void> {
        const resolved = this.resolvePath(target);

        return this.syscall<void>('fs:umount', resolved);
    }

    /**
     * Read a file as raw bytes.
     *
     * @param path - File path (aliases resolved)
     * @returns File contents as Uint8Array
     */
    async read(path: string): Promise<Uint8Array> {
        const resolved = this.resolvePath(path);
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
     * @param path - File path (aliases resolved)
     * @param encoding - Text encoding (default: 'utf-8')
     * @returns File contents as string
     */
    async text(path: string, encoding: string = 'utf-8'): Promise<string> {
        const bytes = await this.read(path);

        return new TextDecoder(encoding).decode(bytes);
    }

    /**
     * Service management operations.
     *
     * @param action - Action to perform (start, stop, status, list)
     * @param nameOrPid - Service name or PID
     * @returns Action result
     *
     * @example
     * ```typescript
     * // Start a service
     * await os.service('start', 'httpd');
     *
     * // Stop a service
     * await os.service('stop', 'httpd');
     *
     * // Get service status
     * const info = await os.service('status', 'httpd');
     * ```
     */
    async service(action: string, nameOrPid?: string | number): Promise<unknown> {
        // Service management operates on kernel service registry
        if (!this.kernel) {
            throw new EINVAL('OS not booted');
        }

        const services = this.kernel.getServices();

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

                // Check if already activated
                if (this.kernel.activationPorts.has(name) || this.kernel.activationAborts.has(name)) {
                    throw new EINVAL(`Service already running: ${name}`);
                }

                await activateService(this.kernel, name, def);

                return { started: name };
            }

            case 'stop': {
                if (!nameOrPid) {
                    throw new EINVAL('Service name required');
                }

                const name = String(nameOrPid);

                // Abort activation loop if running
                const abort = this.kernel.activationAborts.get(name);

                if (abort) {
                    abort.abort();
                    this.kernel.activationAborts.delete(name);
                }

                // Close activation port if exists
                const port = this.kernel.activationPorts.get(name);

                if (port) {
                    await port.close();
                    this.kernel.activationPorts.delete(name);
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

    /**
     * Boot the OS.
     *
     * Initializes all subsystems and returns control to the caller.
     * For standalone mode, use exec() instead.
     *
     * Boot sequence:
     * 1. HAL (hardware abstraction)
     * 2. EMS (entity management)
     * 3. VFS (virtual filesystem)
     * 4. Standard directories
     * 5. Queued packages
     * 6. Kernel
     * 7. Init process (if main provided)
     *
     * @param opts - Optional boot options
     */
    async boot(opts?: BootOpts): Promise<void> {
        if (this.booted) {
            throw new EBUSY('OS already booted');
        }

        const debug = opts?.debug ?? this.config.debug;

        // 1. HAL
        this.hal = new BunHAL(this.buildHALConfig());
        await this.hal.init();
        await this.emit('hal', this);

        // 2. EMS
        this._ems = new EMS(this.hal);
        await this._ems.init();
        await this.emit('ems', this);

        // 3. VFS
        this._vfs = new VFS(this.hal, this._ems);
        await this._vfs.init();
        await this.emit('vfs', this);

        // 4. Standard directories
        await this.createStandardDirectories();

        // 5. Queued packages
        await this.pkg.installQueued();

        // 6. Kernel
        this.kernel = new Kernel(this.hal, this._ems, this._vfs);
        await this.emit('kernel', this);

        // 7. Init process (if main provided)
        const initPath = opts?.main ? this.resolvePath(opts.main) : '/svc/init.ts';

        await this.kernel.boot({
            initPath,
            initArgs: [initPath],
            env: this.config.env ?? {
                HOME: '/',
                USER: 'root',
            },
            debug,
        });

        this.booted = true;
        await this.emit('boot', this);
    }

    /**
     * Execute the OS in standalone mode.
     *
     * Boots the OS and blocks until a shutdown signal (SIGINT/SIGTERM).
     * This is the entry point for `bun run start`.
     *
     * @param opts - Optional exec options
     * @returns Exit code (0 for clean shutdown)
     *
     * @example
     * ```typescript
     * const os = new OS();
     *
     * // Blocks until SIGINT/SIGTERM
     * const exitCode = await os.exec();
     * process.exit(exitCode);
     * ```
     */
    async exec(opts?: ExecOpts): Promise<number> {
        // Boot the OS
        await this.boot({ main: opts?.main });

        // Create shutdown promise that resolves on signal
        const shutdownPromise = new Promise<number>((resolve) => {
            const shutdown = async (signal: string) => {
                console.log(`\nReceived ${signal}, shutting down...`);
                await this.shutdown();
                resolve(0);
            };

            process.on('SIGINT', () => shutdown('SIGINT'));
            process.on('SIGTERM', () => shutdown('SIGTERM'));
        });

        // Log ready state
        console.log('Monk OS running. Press Ctrl+C to stop.');

        // Block until shutdown signal
        return shutdownPromise;
    }

    /**
     * Shutdown the OS gracefully.
     *
     * Shuts down in reverse boot order:
     * Kernel → VFS → EMS → HAL
     */
    async shutdown(): Promise<void> {
        if (!this.booted) {
            return;
        }

        await this.emit('shutdown', this);

        if (this.kernel?.isBooted()) {
            await this.kernel.shutdown();
        }

        if (this._ems) {
            await this._ems.shutdown();
        }

        if (this.hal) {
            await this.hal.shutdown();
        }

        this.booted = false;
        this.kernel = null;
        this._vfs = null;
        this._ems = null;
        this.hal = null;
    }

    /**
     * Check if the OS is booted.
     */
    isBooted(): boolean {
        return this.booted;
    }

    /**
     * Get the HAL instance (for testing/advanced use).
     */
    getHAL(): HAL {
        if (!this.hal) {
            throw new EINVAL('OS not booted');
        }

        return this.hal;
    }

    /**
     * Get the VFS instance (for testing/advanced use).
     */
    getVFS(): VFS {
        if (!this._vfs) {
            throw new EINVAL('OS not booted');
        }

        return this._vfs;
    }

    /**
     * Get the Kernel instance (for testing/advanced use).
     */
    getKernel(): Kernel {
        if (!this.kernel) {
            throw new EINVAL('OS not booted');
        }

        return this.kernel;
    }

    /**
     * Get the EMS instance (for testing/advanced use).
     */
    getEMS(): EMS {
        if (!this._ems) {
            throw new EINVAL('OS not booted');
        }

        return this._ems;
    }

    /**
     * Get the EntityOps instance (for EntityAPI).
     */
    getEntityOps(): EntityOps {
        if (!this._ems) {
            throw new EINVAL('OS not booted');
        }

        return this._ems.ops;
    }

    /**
     * Get active services.
     * Returns empty map if kernel not booted with init process.
     */
    getServices(): Map<string, ServiceDef> {
        if (!this.kernel?.isBooted()) {
            return new Map();
        }

        return this.kernel.getServices();
    }

    /**
     * Get the OS environment variables.
     */
    getEnv(): Record<string, string> {
        return this.config.env ?? {};
    }

    /**
     * Build HAL configuration from OS config.
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
     * Creates the base directory structure needed for package installation
     * and general OS operation.
     */
    private async createStandardDirectories(): Promise<void> {
        if (!this._vfs) {
            return;
        }

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
                await this._vfs.mkdir(dir, 'kernel', { recursive: true });
            }
            catch (err) {
                // EEXIST is fine - directory already exists
                const error = err as Error & { code?: string };

                if (error.code !== 'EEXIST') {
                    // Log but don't fail - some dirs may not be creatable
                }
            }
        }
    }

    /**
     * Emit a lifecycle event, calling all registered listeners.
     *
     * @param event - Event name
     * @param args - Arguments to pass to listeners
     */
    private async emit<K extends OSEventName>(
        event: K,
        ...args: Parameters<OSEvents[K]>
    ): Promise<void> {
        const callbacks = this.listeners[event] as Array<(...a: Parameters<OSEvents[K]>) => void | Promise<void>>;

        for (const callback of callbacks) {
            await callback(...args);
        }
    }
}
