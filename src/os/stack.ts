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

import type { HAL, HALConfig } from '@src/hal/index.js';
import { BunHAL } from '@src/hal/index.js';
import { VFS } from '@src/vfs/vfs.js';
import { Kernel } from '@src/kernel/kernel.js';
import { createDatabase, type DatabaseConnection } from '@src/ems/connection.js';
import { EntityOps } from '@src/ems/entity-ops.js';
import { ModelCache } from '@src/ems/model-cache.js';
import { EntityCache } from '@src/ems/entity-cache.js';
import { createObserverRunner, type ObserverRunner } from '@src/ems/observers/registry.js';

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

    /** Database connection (if ems enabled) */
    db?: DatabaseConnection;

    /** Model cache (if ems enabled) */
    modelCache?: ModelCache;

    /** Observer runner (if ems enabled) */
    observerRunner?: ObserverRunner;

    /** Entity operations (if ems enabled) */
    entityOps?: EntityOps;

    /** Entity cache (if ems enabled) */
    entityCache?: EntityCache;

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
    let db: DatabaseConnection | undefined;
    let modelCache: ModelCache | undefined;
    let observerRunner: ObserverRunner | undefined;
    let entityOps: EntityOps | undefined;
    let entityCache: EntityCache | undefined;
    let vfs: VFS | undefined;
    let kernel: Kernel | undefined;
    let isShutdown = false;

    // Shutdown function (created early so it can be called on error)
    const shutdown = async (): Promise<void> => {
        if (isShutdown) return;
        isShutdown = true;

        // Shutdown in reverse order
        if (kernel?.isBooted()) {
            await kernel.shutdown();
        }

        if (db) {
            await db.close();
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
            } else {
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
            db = await createDatabase(hal.channel, hal.file);
            modelCache = new ModelCache(db);
            observerRunner = createObserverRunner();
            entityOps = new EntityOps(db, modelCache, observerRunner);
            entityCache = new EntityCache();
            await entityCache.loadFromDatabase(db);

            // Wire entityCache to entityOps for Ring 8 EntityCacheSync observer
            entityOps.setEntityCache(entityCache);
        }

        // =====================================================================
        // VFS Layer
        // =====================================================================
        if (needVfs && hal && entityCache && entityOps) {
            vfs = new VFS(hal, entityCache, entityOps);
            await vfs.init();
        }

        // =====================================================================
        // Kernel Layer
        // =====================================================================
        if (needKernel && hal && vfs) {
            kernel = new Kernel(hal, vfs);
        }

        // Return the stack
        return {
            hal: hal!,
            ownsHal,
            db,
            modelCache,
            observerRunner,
            entityOps,
            entityCache,
            vfs,
            kernel,
            shutdown,
        };
    } catch (error) {
        // Clean up on error
        await shutdown();
        throw error;
    }
}
