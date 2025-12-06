/**
 * EMS - Entity Management System
 *
 * Unified entry point for the Entity Management System. Encapsulates all
 * EMS components (database, caches, observer pipeline) into a single
 * cohesive interface.
 *
 * ARCHITECTURE
 * ============
 * ```
 * ┌─────────────────────────────────────┐
 * │  EMS (this module)                  │  ← Unified entry point
 * ├─────────────────────────────────────┤
 * │  EntityOps                          │  ← Streaming CRUD + observers
 * │  EntityCache                        │  ← Path resolution cache
 * │  ModelCache                         │  ← Model metadata cache
 * │  ObserverRunner                     │  ← 8-ring observer pipeline
 * ├─────────────────────────────────────┤
 * │  DatabaseConnection                 │  ← HAL channel wrapper
 * └─────────────────────────────────────┘
 * ```
 *
 * USAGE
 * =====
 * ```typescript
 * import { EMS } from '@src/ems/ems.js';
 *
 * // Create and initialize
 * const ems = new EMS(hal);
 * await ems.init();
 *
 * // Use components
 * for await (const user of ems.ops.selectAny('users', { limit: 10 })) {
 *     console.log(user);
 * }
 *
 * // Shutdown
 * await ems.shutdown();
 * ```
 *
 * @module ems/ems
 */

import type { HAL } from '@src/hal/index.js';
import { EINVAL } from '@src/hal/errors.js';
import { createDatabase, type DatabaseConnection } from './connection.js';
import { ModelCache } from './model-cache.js';
import { EntityCache } from './entity-cache.js';
import { EntityOps } from './entity-ops.js';
import { createObserverRunner, type ObserverRunner } from './observers/index.js';
import { EntityAPI } from '@src/os/ems.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * EMS configuration options.
 */
export interface EMSConfig {
    /** Database path (default: ':memory:' for in-memory) */
    path?: string;
}

// =============================================================================
// EMS CLASS
// =============================================================================

/**
 * Entity Management System - unified database and entity operations.
 *
 * Follows the same pattern as HAL and VFS:
 * - Constructor takes dependencies
 * - init() performs async initialization
 * - shutdown() performs cleanup
 */
export class EMS {
    // =========================================================================
    // STATE
    // =========================================================================

    private readonly hal: HAL;
    private readonly config: EMSConfig;

    private _db: DatabaseConnection | null = null;
    private _models: ModelCache | null = null;
    private _runner: ObserverRunner | null = null;
    private _ops: EntityOps | null = null;
    private _cache: EntityCache | null = null;
    private _api: EntityAPI | null = null;

    private initialized = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create an EMS instance.
     *
     * @param hal - HAL instance for database channel access
     * @param config - Optional configuration
     */
    constructor(hal: HAL, config: EMSConfig = {}) {
        this.hal = hal;
        this.config = config;
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Initialize the EMS.
     *
     * Creates database connection, caches, and observer pipeline.
     * Must be called before accessing any components.
     *
     * @throws EINVAL if already initialized
     */
    async init(): Promise<void> {
        if (this.initialized) {
            throw new EINVAL('EMS already initialized');
        }

        // 1. Create database connection with schema
        this._db = await createDatabase(
            this.hal.channel,
            this.hal.file,
            this.config.path,
        );

        // 2. Create model metadata cache
        this._models = new ModelCache(this._db);

        // 3. Create observer pipeline runner
        this._runner = createObserverRunner();

        // 4. Create entity operations (streaming CRUD with observers)
        this._ops = new EntityOps(this._db, this._models, this._runner);

        // 5. Create entity cache and populate from database
        this._cache = new EntityCache();
        await this._cache.loadFromDatabase(this._db);

        // 6. Wire entity cache to ops for Ring 8 EntityCacheSync observer
        this._ops.setEntityCache(this._cache);

        this.initialized = true;
    }

    /**
     * Shutdown the EMS.
     *
     * Closes database connection and releases resources.
     * Safe to call multiple times.
     */
    async shutdown(): Promise<void> {
        if (this._db) {
            await this._db.close();
            this._db = null;
        }

        this._models = null;
        this._runner = null;
        this._ops = null;
        this._cache = null;
        this._api = null;
        this.initialized = false;
    }

    /**
     * Check if EMS is initialized.
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    // =========================================================================
    // COMPONENT ACCESSORS
    // =========================================================================

    /**
     * Database connection.
     *
     * @throws EINVAL if not initialized
     */
    get db(): DatabaseConnection {
        if (!this._db) {
            throw new EINVAL('EMS not initialized');
        }

        return this._db;
    }

    /**
     * Entity operations (streaming CRUD with observer pipeline).
     *
     * @throws EINVAL if not initialized
     */
    get ops(): EntityOps {
        if (!this._ops) {
            throw new EINVAL('EMS not initialized');
        }

        return this._ops;
    }

    /**
     * Entity path resolution cache.
     *
     * @throws EINVAL if not initialized
     */
    get cache(): EntityCache {
        if (!this._cache) {
            throw new EINVAL('EMS not initialized');
        }

        return this._cache;
    }

    /**
     * Model metadata cache.
     *
     * @throws EINVAL if not initialized
     */
    get models(): ModelCache {
        if (!this._models) {
            throw new EINVAL('EMS not initialized');
        }

        return this._models;
    }

    /**
     * Observer pipeline runner.
     *
     * @throws EINVAL if not initialized
     */
    get runner(): ObserverRunner {
        if (!this._runner) {
            throw new EINVAL('EMS not initialized');
        }

        return this._runner;
    }

    /**
     * Entity API (array-based convenience wrapper).
     *
     * Lazily created on first access. Provides methods like createOne(),
     * deleteOne(), selectAny() that return arrays/promises instead of
     * async generators.
     *
     * @throws EINVAL if not initialized
     */
    get api(): EntityAPI {
        if (!this._ops) {
            throw new EINVAL('EMS not initialized');
        }

        // WHY: Lazy creation - only allocate if actually used
        if (!this._api) {
            this._api = new EntityAPI({ getEntityOps: () => this.ops });
        }

        return this._api;
    }
}
