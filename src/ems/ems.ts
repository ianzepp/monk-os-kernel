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
 * │  PathCache                          │  ← Path resolution cache (VFS)
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
import { PathCache } from '@src/vfs/path-cache.js';
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

/**
 * Options for EMS.exec().
 */
export interface ExecOptions {
    /** Clear entire model cache after exec (for bulk schema loads) */
    clearModels?: boolean;

    /** Invalidate specific models after exec */
    invalidate?: string[];
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
    private _pathCache: PathCache | null = null;
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

        // 5. Create path cache and populate from database
        this._pathCache = new PathCache();
        await this._pathCache.loadFromDatabase(this._db);

        // 6. Wire path cache to ops for Ring 8 PathCacheSync observer
        this._ops.setPathCache(this._pathCache);

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
        this._pathCache = null;
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
     * Path resolution cache.
     *
     * @throws EINVAL if not initialized
     */
    get pathCache(): PathCache {
        if (!this._pathCache) {
            throw new EINVAL('EMS not initialized');
        }

        return this._pathCache;
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

    // =========================================================================
    // SCHEMA OPERATIONS
    // =========================================================================

    /**
     * Execute raw SQL with optional cache management.
     *
     * WHY: Subsystems need to register their schema during initialization.
     * Access is capability-based: only code with an EMS reference can call this.
     *
     * @param sql - SQL to execute
     * @param options - Cache invalidation options
     */
    async exec(sql: string, options?: ExecOptions): Promise<void> {
        if (!this._db) {
            throw new EINVAL('EMS not initialized');
        }

        await this._db.exec(sql);

        if (options?.clearModels) {
            this._models?.clear();
        }
        else if (options?.invalidate) {
            for (const model of options.invalidate) {
                this._models?.invalidate(model);
            }
        }
    }

    // =========================================================================
    // MODEL IMPORT
    // =========================================================================

    /**
     * Known model-level properties for import.
     */
    private static readonly MODEL_PROPS = new Set([
        'status',
        'description',
        'sudo',
        'frozen',
        'immutable',
        'external',
        'passthrough',
        'pathname',
    ]);

    /**
     * Import a model definition with embedded field definitions.
     *
     * Direct API equivalent of the ems:import syscall. Use this for kernel-level
     * initialization (VFS, auth, etc.) where syscalls aren't available.
     *
     * The operation is strictly additive:
     * - Model is upserted (created or updated)
     * - Fields are upserted (created or updated)
     * - Existing fields not in the definition are NOT removed
     *
     * Ring 6 DDL observers handle the actual table/column creation.
     *
     * @param modelName - Model name to import
     * @param definition - Model definition with optional flags and fields object
     *
     * @example
     * ```typescript
     * await ems.importModel('window', {
     *     description: 'Application window',
     *     passthrough: false,
     *     fields: {
     *         title: { type: 'text', required: true },
     *         x: { type: 'integer', default_value: '0' },
     *         y: { type: 'integer', default_value: '0' }
     *     }
     * });
     * ```
     */
    async importModel(
        modelName: string,
        definition: Record<string, unknown>,
    ): Promise<void> {
        if (!this._ops) {
            throw new EINVAL('EMS not initialized');
        }

        const fields = definition.fields;

        if (typeof fields !== 'object' || fields === null) {
            throw new EINVAL('definition.fields must be an object');
        }

        const fieldsObj = fields as Record<string, unknown>;

        // Build model record from known properties
        const modelRecord: Record<string, unknown> = {
            model_name: modelName,
        };

        for (const prop of EMS.MODEL_PROPS) {
            if (prop in definition) {
                modelRecord[prop] = definition[prop];
            }
        }

        // Upsert model
        let existingModelId: string | undefined;

        for await (const existing of this._ops.selectAny('models', {
            where: { model_name: modelName },
        })) {
            existingModelId = (existing as Record<string, unknown>).id as string;
            break;
        }

        if (existingModelId) {
            const { model_name: _, ...changes } = modelRecord;

            if (Object.keys(changes).length > 0) {
                await this._ops.updateOne('models', existingModelId, changes);
            }
        }
        else {
            await this._ops.createOne('models', modelRecord);
        }

        // Upsert fields
        for (const [fieldName, fieldDef] of Object.entries(fieldsObj)) {
            if (typeof fieldDef !== 'object' || fieldDef === null) {
                throw new EINVAL(`Field '${fieldName}' definition must be an object`);
            }

            const fieldRecord: Record<string, unknown> = {
                model_name: modelName,
                field_name: fieldName,
                ...(fieldDef as Record<string, unknown>),
            };

            let existingFieldId: string | undefined;

            for await (const existing of this._ops.selectAny('fields', {
                where: { model_name: modelName, field_name: fieldName },
            })) {
                existingFieldId = (existing as Record<string, unknown>).id as string;
                break;
            }

            if (existingFieldId) {
                const { model_name: _m, field_name: _f, ...changes } = fieldRecord;

                if (Object.keys(changes).length > 0) {
                    await this._ops.updateOne('fields', existingFieldId, changes);
                }
            }
            else {
                await this._ops.createOne('fields', fieldRecord);
            }
        }

        // Invalidate model cache for the imported model
        this._models?.invalidate(modelName);
    }
}
