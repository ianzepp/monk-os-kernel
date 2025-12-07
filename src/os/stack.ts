/**
 * OS Stack - Composable OS layer initialization
 *
 * PURPOSE
 * =======
 * Provides a flexible factory for creating OS layers (HAL, EMS, VFS, Kernel)
 * with automatic dependency resolution. Used internally by the OS class and
 * externally by tests that need specific layer combinations.
 *
 * LAYER DEPENDENCIES
 * ==================
 * kernel → vfs → ems → hal
 *
 * Requesting a layer automatically includes its dependencies.
 * For example, `{ vfs: true }` implies `{ hal: true, ems: true, vfs: true }`.
 *
 * USAGE EXAMPLES
 * ==============
 * ```typescript
 * // Full stack for integration tests
 * const stack = await createOsStack({ kernel: true });
 *
 * // VFS testing (no kernel)
 * const stack = await createOsStack({ vfs: true });
 *
 * // EMS testing (no VFS)
 * const stack = await createOsStack({ ems: true });
 *
 * // Custom HAL
 * const stack = await createOsStack({ hal: myHal, vfs: true });
 *
 * // Always shutdown when done
 * await stack.shutdown();
 * ```
 *
 * @module os/stack
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HAL, HALConfig } from '@src/hal/index.js';
import { BunHAL } from '@src/hal/index.js';
import { VFS } from '@src/vfs/vfs.js';
import { Kernel } from '@src/kernel/kernel.js';
import { EMS } from '@src/ems/ems.js';
import { SyscallDispatcher } from '@src/syscall/index.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for creating an OS stack.
 *
 * Each layer can be enabled with `true` or disabled with `false`/`undefined`.
 * The `hal` option can also accept an existing HAL instance or HALConfig.
 *
 * Dependencies cascade upward:
 * - `kernel: true` implies `vfs: true`
 * - `vfs: true` implies `ems: true`
 * - `ems: true` implies `hal: true`
 */
export interface OsStackOptions {
    /**
     * HAL layer configuration.
     * - `true`: Create BunHAL with default config
     * - `false`/`undefined`: No HAL (only valid if no other layers requested)
     * - `HAL`: Use existing HAL instance (will NOT be shutdown)
     * - `HALConfig`: Create BunHAL with this config
     */
    hal?: boolean | HAL | HALConfig;

    /**
     * EMS layer (Entity Model System).
     * Creates: db, modelCache, observerRunner, entityOps, entityCache
     * Implies: hal
     */
    ems?: boolean;

    /**
     * VFS layer (Virtual File System).
     * Creates: vfs
     * Implies: ems
     */
    vfs?: boolean;

    /**
     * Kernel layer.
     * Creates: kernel
     * Implies: vfs
     */
    kernel?: boolean;

    /**
     * ROM path to copy into VFS.
     * Default: './rom'
     * Set to false to skip ROM copy.
     */
    rom?: string | false;
}

/**
 * The created OS stack with all requested layers.
 *
 * Only layers that were requested (or implied) will be present.
 * Always call `shutdown()` when done to clean up resources.
 */
export interface OsStack {
    /** HAL instance (always present) */
    hal: HAL;

    /** Whether we own the HAL (should shutdown) */
    ownsHal: boolean;

    /** Entity Management System (if ems enabled) */
    ems?: EMS;

    /** Virtual file system (if vfs enabled) */
    vfs?: VFS;

    /** Kernel (if kernel enabled) */
    kernel?: Kernel;

    /**
     * Shutdown all stack layers in reverse order.
     * Safe to call multiple times.
     */
    shutdown(): Promise<void>;
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Check if value is an existing HAL instance.
 */
function isHAL(value: unknown): value is HAL {
    return (
        typeof value === 'object' &&
        value !== null &&
        'init' in value &&
        'shutdown' in value &&
        'storage' in value
    );
}

/**
 * Check if value is a HALConfig object.
 */
function isHALConfig(value: unknown): value is HALConfig {
    return (
        typeof value === 'object' &&
        value !== null &&
        !isHAL(value) &&
        ('storage' in value || Object.keys(value).length === 0)
    );
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create an OS stack with the specified layers.
 *
 * Layers are created in dependency order (hal → ems → vfs → kernel).
 * Each layer is initialized before the next is created.
 *
 * @param opts - Stack options specifying which layers to create
 * @returns Initialized stack with requested layers
 *
 * @example
 * ```typescript
 * // Create full stack for tests
 * const stack = await createOsStack({ kernel: true });
 * try {
 *     // Use stack.vfs, stack.kernel, etc.
 * } finally {
 *     await stack.shutdown();
 * }
 * ```
 */
export async function createOsStack(opts: OsStackOptions = {}): Promise<OsStack> {
    // Resolve dependencies (cascade upward)
    const needKernel = opts.kernel === true;
    const needVfs = opts.vfs === true || needKernel;
    const needEms = opts.ems === true || needVfs;
    const needHal = opts.hal !== false || needEms;

    // Track what we create for shutdown
    let hal: HAL | undefined;
    let ownsHal = false;
    let ems: EMS | undefined;
    let vfs: VFS | undefined;
    let kernel: Kernel | undefined;
    let isShutdown = false;

    // Shutdown function (created early so it can be called on error)
    const shutdown = async (): Promise<void> => {
        if (isShutdown) {
            return;
        }

        isShutdown = true;

        // Shutdown in reverse order: Kernel → VFS → EMS → HAL
        if (kernel?.isBooted()) {
            await kernel.shutdown();
        }

        if (vfs) {
            await vfs.shutdown();
        }

        if (ems) {
            await ems.shutdown();
        }

        if (ownsHal && hal) {
            await hal.shutdown();
        }
    };

    try {
        // =====================================================================
        // HAL Layer
        // =====================================================================
        if (needHal) {
            if (isHAL(opts.hal)) {
                // Use existing HAL (don't shutdown)
                hal = opts.hal;
                ownsHal = false;
            }
            else {
                // Create new HAL
                const config = isHALConfig(opts.hal) ? opts.hal : undefined;

                hal = new BunHAL(config);
                await hal.init();
                ownsHal = true;
            }
        }

        // =====================================================================
        // EMS Layer
        // =====================================================================
        if (needEms && hal) {
            ems = new EMS(hal);
            await ems.init();
        }

        // =====================================================================
        // VFS Layer
        // =====================================================================
        if (needVfs && hal && ems) {
            vfs = new VFS(hal, ems);
            await vfs.init();

            // Copy ROM to VFS if kernel requested (unless explicitly disabled)
            if (needKernel && opts.rom !== false) {
                const romPath = typeof opts.rom === 'string' ? opts.rom : './rom';

                await copyRomToVfs(vfs, romPath);
            }
        }

        // =====================================================================
        // Kernel Layer
        // =====================================================================
        if (needKernel && hal && vfs) {
            kernel = new Kernel(hal, ems, vfs);

            // Wire syscall dispatcher (sits outside kernel, orchestrates syscalls)
            const dispatcher = new SyscallDispatcher(kernel, vfs, ems, hal);

            kernel.onWorkerMessage = (worker, msg) => dispatcher.onWorkerMessage(worker, msg);
        }

        // Return the stack
        return {
            hal: hal!,
            ownsHal,
            ems,
            vfs,
            kernel,
            shutdown,
        };
    }
    catch (error) {
        // Clean up on error
        await shutdown();
        throw error;
    }
}

// =============================================================================
// ROM COPY HELPERS
// =============================================================================

/**
 * Copy ROM directory into VFS.
 *
 * Copies the ROM directory tree from host filesystem into the VFS root.
 * This provides userland code (bin, lib, svc, etc.) for the kernel.
 */
async function copyRomToVfs(vfs: VFS, romPath: string): Promise<void> {
    try {
        await fs.access(romPath);
    }
    catch {
        // ROM path doesn't exist, skip silently
        return;
    }

    await copyDirToVfs(vfs, romPath, '/');
}

/**
 * Recursively copy a host directory into VFS.
 */
async function copyDirToVfs(vfs: VFS, hostPath: string, vfsPath: string): Promise<void> {
    // Ensure target directory exists
    try {
        await vfs.stat(vfsPath, 'kernel');
    }
    catch {
        await vfs.mkdir(vfsPath, 'kernel', { recursive: true });
    }

    const entries = await fs.readdir(hostPath, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(hostPath, entry.name);
        const dstPath = vfsPath === '/' ? `/${entry.name}` : `${vfsPath}/${entry.name}`;

        if (entry.isDirectory()) {
            await copyDirToVfs(vfs, srcPath, dstPath);
        }
        else if (entry.isFile()) {
            await copyFileToVfs(vfs, srcPath, dstPath);
        }
    }
}

/**
 * Copy a single file from host to VFS.
 */
async function copyFileToVfs(vfs: VFS, hostPath: string, vfsPath: string): Promise<void> {
    // Ensure parent directory exists
    const parent = vfsPath.substring(0, vfsPath.lastIndexOf('/')) || '/';

    try {
        await vfs.stat(parent, 'kernel');
    }
    catch {
        await vfs.mkdir(parent, 'kernel', { recursive: true });
    }

    // Read from host, write to VFS
    const content = await fs.readFile(hostPath);
    const handle = await vfs.open(vfsPath, { write: true, create: true, truncate: true }, 'kernel');

    try {
        await handle.write(new Uint8Array(content));
    }
    finally {
        await handle.close();
    }
}
