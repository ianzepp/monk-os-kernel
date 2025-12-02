/**
 * OS - The public API for Monk OS
 *
 * External applications use this class to boot and interact with Monk OS.
 * Wraps HAL, VFS, and Kernel into a single cohesive interface.
 *
 * @see planning/OS_BOOT_EXEC.md for the full specification
 */

import type { HAL, HALConfig } from '@src/hal/index.js';
import { BunHAL } from '@src/hal/index.js';
import { VFS } from '@src/vfs/vfs.js';
import { Kernel } from '@src/kernel/kernel.js';
import type { ServiceDef } from '@src/kernel/services.js';
import type { OSConfig, BootOpts, ExecOpts, OSEvents, OSEventName } from './types.js';
import { FilesystemAPI } from './fs.js';
import { ProcessAPI } from './process.js';
import { ServiceAPI } from './service.js';

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
    private booted = false;

    // Path aliases
    private aliases: Map<string, string> = new Map();

    // Lifecycle event listeners
    private listeners: EventListeners = {
        hal: [],
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

    constructor(config?: OSConfig) {
        this.fs = new FilesystemAPI(this);
        this.process = new ProcessAPI(this);
        this.service = new ServiceAPI(this);
        this.config = config ?? {};

        // Initialize aliases from config
        if (config?.aliases) {
            for (const [name, path] of Object.entries(config.aliases)) {
                this.aliases.set(name, path);
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
     * Register a lifecycle event listener.
     *
     * Listeners are called during boot() at the appropriate stage.
     *
     * @param event - Event name ('hal', 'vfs', 'kernel', 'boot', 'shutdown')
     * @param callback - Function to call when event fires
     * @returns this for chaining
     *
     * @example
     * ```typescript
     * const os = new OS()
     *   .on('hal', (hal) => {
     *     // Configure HAL after initialization
     *   })
     *   .on('vfs', (vfs) => {
     *     // Add mounts before kernel starts
     *     vfs.mountHost('/vol/app', './src');
     *   })
     *   .on('kernel', (kernel) => {
     *     // Register services before init spawns
     *   })
     *   .on('boot', () => {
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
     * Initializes HAL, VFS, and kernel. Returns control to the caller.
     * The OS runs in the background, accessible via the os.* API.
     *
     * Boot sequence:
     * 1. Create and initialize HAL
     * 2. Emit 'hal' event (configure HAL features)
     * 3. Create VFS
     * 4. Initialize VFS (creates /dev, /etc, etc.)
     * 5. Emit 'vfs' event (configure mounts)
     * 6. Create Kernel
     * 7. Emit 'kernel' event (register services)
     * 8. Spawn init process if main provided
     * 9. Emit 'ready' event
     *
     * @param opts - Optional boot options (e.g., main script)
     */
    async boot(opts?: BootOpts): Promise<void> {
        if (this.booted) {
            throw new Error('OS already booted');
        }

        // 1. Create and initialize HAL
        this.hal = new BunHAL(this.buildHALConfig());
        await this.hal.init();

        // 2. Emit 'hal' event - configure HAL features
        await this.emit('hal', this.hal);

        // 3. Create VFS
        this.vfs = new VFS(this.hal);

        // 4. Initialize VFS (creates /dev, etc.)
        await this.vfs.init();

        // 5. Emit 'vfs' event - configure mounts
        await this.emit('vfs', this.vfs);

        // 6. Create Kernel
        this.kernel = new Kernel(this.hal, this.vfs);

        // 7. Emit 'kernel' event - register services
        await this.emit('kernel', this.kernel);

        // 8. If main is provided, boot with init process
        if (opts?.main) {
            const initPath = this.resolvePath(opts.main);
            await this.kernel.boot({
                initPath,
                initArgs: [initPath],
                env: this.config.env ?? {
                    HOME: '/',
                    USER: 'root',
                    SHELL: '/bin/shell',
                },
                debug: opts.debug,
            });
        }

        this.booted = true;

        // 9. Emit 'boot' event - OS fully booted
        await this.emit('boot');
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

        throw new Error('os.exec() takeover mode not implemented');
    }

    /**
     * Shutdown the OS gracefully.
     */
    async shutdown(): Promise<void> {
        if (!this.booted) return;

        // Emit 'shutdown' event before teardown
        await this.emit('shutdown');

        if (this.kernel?.isBooted()) {
            await this.kernel.shutdown();
        }

        if (this.hal) {
            await this.hal.shutdown();
        }

        this.booted = false;
        this.hal = null;
        this.vfs = null;
        this.kernel = null;
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
            throw new Error('OS not booted');
        }
        return this.hal;
    }

    /**
     * Get the VFS instance (for testing/advanced use).
     */
    getVFS(): VFS {
        if (!this.vfs) {
            throw new Error('OS not booted');
        }
        return this.vfs;
    }

    /**
     * Get the Kernel instance (for testing/advanced use).
     */
    getKernel(): Kernel {
        if (!this.kernel) {
            throw new Error('OS not booted');
        }
        return this.kernel;
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
                throw new Error('PostgreSQL storage requires url');
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
