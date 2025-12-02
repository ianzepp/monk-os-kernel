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

/**
 * Storage configuration for the OS
 */
export interface StorageConfig {
    type: 'memory' | 'sqlite' | 'postgres';
    url?: string;
    path?: string;
}

/**
 * OS configuration options
 */
export interface OSConfig {
    /**
     * Path aliases for convenient referencing.
     * Maps alias names (e.g., '@app') to OS paths (e.g., '/vol/app').
     */
    aliases?: Record<string, string>;

    /**
     * Storage backend configuration.
     * Defaults to in-memory storage.
     */
    storage?: StorageConfig;

    /**
     * Environment variables available to all processes.
     */
    env?: Record<string, string>;
}

/**
 * Boot options
 */
export interface BootOpts {
    /**
     * Path to init script (inside OS).
     * If provided, spawns this as PID 1.
     */
    main?: string;

    /**
     * Enable kernel debug logging (printk).
     */
    debug?: boolean;
}

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

    constructor(config?: OSConfig) {
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
     * @param opts - Optional boot options (e.g., main script)
     */
    async boot(opts?: BootOpts): Promise<void> {
        if (this.booted) {
            throw new Error('OS already booted');
        }

        // 1. Create and initialize HAL
        this.hal = new BunHAL(this.buildHALConfig());
        await this.hal.init();

        // 2. Create VFS
        this.vfs = new VFS(this.hal);

        // 3. Create Kernel
        this.kernel = new Kernel(this.hal, this.vfs);

        // 4. Initialize VFS (creates /dev, etc.)
        await this.vfs.init();

        // 5. If main is provided, boot with init process
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
    }

    /**
     * Shutdown the OS gracefully.
     */
    async shutdown(): Promise<void> {
        if (!this.booted) return;

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
}
