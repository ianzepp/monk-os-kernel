/**
 * OS - The public API for Monk OS
 *
 * External applications use this class to boot and interact with Monk OS.
 * Wraps HAL, VFS, and Kernel into a single cohesive interface.
 *
 * @see planning/OS_BOOT_EXEC.md for the full specification
 */

import type { HAL, HALConfig } from '@src/hal/index.js';
import { BunHAL, EINVAL, EBUSY, ENOSYS } from '@src/hal/index.js';
import { VFS } from '@src/vfs/vfs.js';
import { Kernel } from '@src/kernel/kernel.js';
import type { ServiceDef } from '@src/kernel/services.js';
import type { OSConfig, BootOpts, ExecOpts, OSEvents, OSEventName, PackageOpts } from './types.js';
import { FilesystemAPI } from './fs.js';
import { ProcessAPI } from './process.js';
import { ServiceAPI } from './service.js';
import { PackageAPI } from './pkg.js';
import { EntityAPI } from './ems.js';
import { createDatabase, type DatabaseConnection } from '@src/ems/connection.js';
import { EntityOps } from '@src/ems/entity-ops.js';
import { ModelCache } from '@src/ems/model-cache.js';
import { EntityCache } from '@src/ems/entity-cache.js';
import { createObserverRunner } from '@src/ems/observers/registry.js';

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
    private vfs: VFS | null = null;
    private kernel: Kernel | null = null;
    private db: DatabaseConnection | null = null;
    private entityOps: EntityOps | null = null;
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
     * Filesystem API for file operations.
     */
    readonly fs: FilesystemAPI;

    /**
     * Process API for spawning and running processes.
     */
    readonly process: ProcessAPI;

    /**
     * Service API for managing services.
     */
    readonly service: ServiceAPI;

    /**
     * Package API for managing OS packages.
     */
    readonly pkg: PackageAPI;

    /**
     * Entity Model System API for entity operations.
     */
    readonly ems: EntityAPI;

    constructor(config?: OSConfig) {
        this.fs = new FilesystemAPI(this);
        this.process = new ProcessAPI(this);
        this.service = new ServiceAPI(this);
        this.pkg = new PackageAPI(this);
        this.ems = new EntityAPI(this);
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
                } else {
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
                'Cannot use os.install() after boot. Use os.pkg.install() instead.'
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

    /**
     * Boot the OS in headless mode.
     *
     * Initializes HAL, EMS, VFS, and kernel. Returns control to the caller.
     * The OS runs in the background, accessible via the os.* API.
     *
     * Boot sequence:
     * 1. Create and initialize HAL
     * 2. Emit 'hal' event
     * 3. Create Entity Model System (EMS)
     * 4. Emit 'ems' event (os.ems.* available)
     * 5. Create and initialize VFS
     * 6. Emit 'vfs' event (os.fs.* available)
     * 7. Install queued packages
     * 8. Create Kernel
     * 9. Emit 'kernel' event
     * 10. Spawn init process if main provided
     * 11. Emit 'boot' event
     *
     * @param opts - Optional boot options (e.g., main script)
     */
    async boot(opts?: BootOpts): Promise<void> {
        if (this.booted) {
            throw new EBUSY('OS already booted');
        }

        // 1. Create and initialize HAL
        this.hal = new BunHAL(this.buildHALConfig());
        await this.hal.init();

        // 2. Emit 'hal' event
        await this.emit('hal', this);

        // 3. Create Entity Model System (EMS)
        this.db = await createDatabase(this.hal.channel, this.hal.file);
        const modelCache = new ModelCache(this.db);
        const runner = createObserverRunner();
        this.entityOps = new EntityOps(this.db, modelCache, runner);
        const entityCache = new EntityCache();
        await entityCache.loadFromDatabase(this.db);

        // Wire entityCache to entityOps for Ring 8 EntityCacheSync observer
        this.entityOps.setEntityCache(entityCache);

        // 4. Emit 'ems' event - os.ems.* available
        await this.emit('ems', this);

        // 5. Create and initialize VFS
        this.vfs = new VFS(this.hal, entityCache, this.entityOps);
        await this.vfs.init();

        // 6. Emit 'vfs' event - os.fs.* available
        await this.emit('vfs', this);

        // 7. Create standard directories (needed before package install)
        await this.createStandardDirectories();

        // 8. Install queued packages
        await this.pkg.installQueued();

        // 8. Create Kernel (with EMS for entity syscalls)
        this.kernel = new Kernel(this.hal, this.vfs, {
            entityOps: this.entityOps ?? undefined,
        });

        // 9. Emit 'kernel' event
        await this.emit('kernel', this);

        // 10. Boot kernel with init process
        // Default to /bin/true.ts for headless mode (exits immediately)
        const initPath = opts?.main ? this.resolvePath(opts.main) : '/bin/true.ts';
        await this.kernel.boot({
            initPath,
            initArgs: [initPath],
            env: this.config.env ?? {
                HOME: '/',
                USER: 'root',
                SHELL: '/bin/shell',
            },
            debug: opts?.debug,
        });

        this.booted = true;

        // 11. Emit 'boot' event - OS fully booted
        await this.emit('boot', this);
    }

    /**
     * Execute the OS in takeover mode.
     *
     * Boots the OS and blocks the calling thread until the init process exits.
     * The App's main thread becomes the OS - this is the "takeover" mode.
     *
     * @param opts - Exec options (main is required)
     * @returns Exit code from the init process
     *
     * @example
     * ```typescript
     * const os = new OS({ aliases: { '@app': '/vol/app' } });
     * os.mount('./src', '@app');
     *
     * // This line blocks until init exits
     * const exitCode = await os.exec({ main: '@app/init.ts' });
     * process.exit(exitCode);
     * ```
     */
    async exec(opts: ExecOpts): Promise<number> {
        // 1. Boot the OS with the main script
        await this.boot({ main: opts.main, debug: opts.debug });

        // 2. Wait for init (PID 1) to exit
        // TODO: Implement init process tracking and wait
        // - Get handle to init process from kernel
        // - Block until init exits
        // - Forward signals (SIGTERM, SIGINT) to init
        // - Return init's exit code

        throw new ENOSYS('os.exec() takeover mode not implemented');
    }

    /**
     * Shutdown the OS gracefully.
     */
    async shutdown(): Promise<void> {
        if (!this.booted) return;

        // Emit 'shutdown' event before teardown
        await this.emit('shutdown', this);

        if (this.kernel?.isBooted()) {
            await this.kernel.shutdown();
        }

        if (this.db) {
            await this.db.close();
        }

        if (this.hal) {
            await this.hal.shutdown();
        }

        this.booted = false;
        this.hal = null;
        this.vfs = null;
        this.kernel = null;
        this.db = null;
        this.entityOps = null;
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
        if (!this.vfs) {
            throw new EINVAL('OS not booted');
        }
        return this.vfs;
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
     * Get the ProcessAPI instance.
     */
    getProcessAPI(): ProcessAPI {
        return this.process;
    }

    /**
     * Get the EntityOps instance (for EntityAPI).
     */
    getEntityOps(): EntityOps {
        if (!this.entityOps) {
            throw new EINVAL('OS not booted');
        }
        return this.entityOps;
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
        if (!this.vfs) return;

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
            } catch (err) {
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
