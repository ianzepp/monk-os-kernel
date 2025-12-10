/**
 * OS - The Production Implementation for Monk OS
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The OS class extends BaseOS with the production boot sequence. It performs
 * a linear, all-or-nothing boot that initializes all subsystems in order.
 *
 * Subsystem initialization order (boot):
 *   HAL -> EMS -> Auth -> LLM -> VFS -> dirs -> ROM -> Kernel -> Dispatcher -> Gateway -> Init
 *
 * For testing with flexible partial boot, use TestOS instead.
 *
 * STATE MACHINE
 * =============
 *
 *   [created] --boot()--> [booting] --success--> [booted]
 *       |                     |                     |
 *       |                     | failure             | shutdown()
 *       |                     v                     v
 *       |                 [failed]              [shutdown]
 *       |                                           |
 *       +-------------------------------------------+
 *                      (can boot again after shutdown)
 *
 * @module os
 */

import type { HALConfig } from '@src/hal/index.js';
import { BunHAL, EINVAL, EBUSY } from '@src/hal/index.js';
import { VFS } from '@src/vfs/vfs.js';
import { Kernel } from '@src/kernel/kernel.js';
import { EMS } from '@src/ems/ems.js';
import { Auth } from '@src/auth/index.js';
import { LLM } from '@src/llm/index.js';
import { SyscallDispatcher } from '@src/syscall/index.js';
import { Gateway } from '@src/gateway/index.js';
import type { BootOpts, ExecOpts } from './types.js';
import { BaseOS } from './base.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Standard directories created during boot.
 */
const STANDARD_DIRECTORIES = [
    '/app',
    '/bin',
    '/ems',
    '/etc',
    '/home',
    '/svc',
    '/tmp',
    '/usr',
    '/var',
    '/var/log',
    '/vol',
];

/**
 * Default init process path.
 */
const DEFAULT_INIT_PATH = '/svc/init.ts';

/**
 * Default ROM source path on host filesystem.
 */
const DEFAULT_ROM_PATH = './rom';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * OS class - production implementation of Monk OS.
 *
 * Provides the full boot sequence for production use.
 * For testing, use TestOS which supports partial boot and HAL injection.
 */
export class OS extends BaseOS {
    // =========================================================================
    // LIFECYCLE: BOOT
    // =========================================================================

    /**
     * Boot the OS.
     *
     * Initializes all subsystems in order and starts the init process.
     * For standalone mode, use exec() instead.
     *
     * @param opts - Optional boot options
     * @throws EBUSY if already booted
     * @throws Error from any subsystem initialization
     */
    async boot(opts?: BootOpts): Promise<void> {
        if (this.booted) {
            throw new EBUSY('OS already booted');
        }

        const debug = opts?.debug ?? this.config.debug;

        try {
            // 1. HAL (hardware abstraction)
            this.__hal = new BunHAL(this.buildHALConfig());
            await this.__hal.init();

            // 2. EMS (entity management)
            // WHY path: EMS and HAL storage must share the same database for persistence.
            // Without this, EMS defaults to :memory: while HAL persists to SQLite file,
            // causing child indexes to survive but entity data to disappear on restart.
            const emsPath = this.config.storage?.type === 'sqlite'
                ? (this.config.storage.path ?? '.data/monk.db')
                : undefined;

            this.__ems = new EMS(this.__hal, { path: emsPath });
            await this.__ems.init();

            // 3. Auth
            // WHY default true: Phase 0 has no auth:login, so users can't authenticate yet.
            // Tests and production can set allowAnonymous: false when ready.
            this.__auth = new Auth(this.__hal, this.__ems, {
                allowAnonymous: this.config.allowAnonymous ?? true,
            });
            await this.__auth.init();

            // 4. LLM (language model inference)
            this.__llm = new LLM(this.__hal, this.__ems);
            await this.__llm.init();

            // 5. VFS (virtual filesystem)
            this.__vfs = new VFS(this.__hal, this.__ems);
            await this.__vfs.init();

            // 6. Standard directories
            await this.createStandardDirectories();

            // 7. ROM copy (userspace code)
            // Skip if filesystem already has content (persistent storage with prior boot)
            let hasExistingContent = false;

            try {
                const binStat = await this.__vfs.stat('/bin', 'kernel');

                if (binStat.model === 'folder') {
                    // Check if /bin has children (indicates ROM was copied)
                    let childCount = 0;

                    for await (const _ of this.__vfs.readdir('/bin', 'kernel')) {
                        childCount++;
                        if (childCount > 0) {
                            hasExistingContent = true;
                            break;
                        }
                    }
                }
            }
            catch {
                // /bin doesn't exist or can't be read - need ROM copy
            }

            if (!hasExistingContent) {
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
            }

            // 8. Kernel + Dispatcher
            this.__kernel = new Kernel(this.__hal, this.__ems, this.__vfs);

            this.__dispatcher = new SyscallDispatcher(
                this.__kernel,
                this.__vfs,
                this.__ems,
                this.__hal,
                this.__auth,
                this.__llm,
            );

            // Wire dispatcher's message handler to kernel
            // WHY: Kernel creates workers, but syscall layer handles messages
            this.__kernel.onWorkerMessage = async (worker, msg) => {
                await this.__dispatcher!.onWorkerMessage(worker, msg);
            };

            // 9. Gateway (external syscall interface)
            const port = this.config.env?.MONK_PORT
                ? parseInt(this.config.env.MONK_PORT, 10)
                : 7778;

            this.__gateway = new Gateway(
                this.__dispatcher,
                this.__kernel,
                this.__hal,
            );

            await this.__gateway.listen(port);

            // 10. Init process
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
            await this.cleanupOnBootFailure();
            throw err;
        }
    }

    /**
     * Execute the OS in standalone mode.
     *
     * Boots the OS and blocks until a shutdown signal (SIGINT/SIGTERM).
     *
     * @param opts - Optional exec options
     * @returns Exit code (0 for clean shutdown)
     */
    async exec(opts?: ExecOpts): Promise<number> {
        await this.boot({ main: opts?.main });

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
    // PRIVATE HELPERS
    // =========================================================================

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

                if (error.code !== 'EEXIST') {
                    console.warn(`Failed to create ${dir}: ${error.message}`);
                }
            }
        }
    }

    /**
     * Clean up subsystems after boot failure.
     *
     * WHY: Maintains INV-2 (booted === false means clean state).
     * Called from boot() catch block.
     *
     * RC-3: Ensures partial boot failure doesn't leave dangling subsystems.
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

        this.__gateway = null;
        this.__dispatcher = null;
        this.__kernel = null;
        this.__vfs = null;
        this.__auth = null;
        this.__ems = null;
        this.__hal = null;
    }
}
