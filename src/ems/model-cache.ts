/**
 * ModelCache - Async model metadata cache with HAL-based access
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * ModelCache provides cached access to model and field definitions stored in
 * the database. All database access goes through HAL channels via the
 * DatabaseConnection class, maintaining the HAL boundary.
 *
 * The cache is async because HAL channels are async. Models are loaded on
 * first access and cached for subsequent lookups. Cache invalidation occurs
 * when model definitions change (via observers).
 *
 * STREAMING PATTERN
 * =================
 * The cache uses the OS message/response streaming pattern internally:
 * ```
 * ModelCache.get('file')
 *     │
 *     ▼
 * DatabaseConnection.query()
 *     │
 *     ▼
 * HAL Channel (sqlite protocol)
 *     │
 *     ▼
 * AsyncIterable<Response> → Model
 * ```
 *
 * USAGE
 * =====
 * ```typescript
 * const cache = new ModelCache(dbConnection);
 *
 * // Get model (async, cached)
 * const fileModel = await cache.get('file');
 * if (fileModel) {
 *     console.log(fileModel.getRequiredFields());
 * }
 *
 * // Get or throw
 * const model = await cache.require('invoice'); // throws if not found
 *
 * // Invalidate after model changes
 * cache.invalidate('invoice');
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: All database access goes through DatabaseConnection (HAL boundary)
 * INV-2: Cached models are immutable after construction
 * INV-3: get() returns undefined for non-existent models, require() throws
 * INV-4: invalidate() removes from cache, next get() reloads from database
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript single-threaded execution means no concurrent cache mutation.
 * However, multiple concurrent get() calls for the same model could trigger
 * multiple database queries before any completes. The `_pending` map
 * deduplicates in-flight requests.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Pending request map prevents duplicate queries for same model
 * RC-2: Cache write happens after query completes, not during
 *
 * @module model/model-cache
 */

import type { DatabaseConnection } from '@src/hal/connection.js';
import { Model, type ModelRow, type FieldRow } from './model.js';
import { ENOENT } from '@src/hal/errors.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * SQL query result for model row.
 *
 * WHY explicit type: Ensures type safety when mapping query results.
 */
interface ModelQueryResult {
    id: string;
    model_name: string;
    status: string;
    description: string | null;
    sudo: number;
    frozen: number;
    immutable: number;
    external: number;
    passthrough: number;
}

/**
 * SQL query result for field row.
 */
interface FieldQueryResult {
    id: string;
    model_name: string;
    field_name: string;
    type: string;
    is_array: number;
    required: number;
    default_value: string | null;
    minimum: number | null;
    maximum: number | null;
    pattern: string | null;
    enum_values: string | null;
    relationship_type: string | null;
    related_model: string | null;
    related_field: string | null;
    relationship_name: string | null;
    cascade_delete: number;
    required_relationship: number;
    immutable: number;
    sudo: number;
    indexed: string | null;
    tracked: number;
    searchable: number;
    transform: string | null;
    description: string | null;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * SQL for loading a model by name.
 *
 * WHY WHERE trashed_at IS NULL: Only load active (non-deleted) models.
 */
const MODEL_QUERY = `
    SELECT id, model_name, status, description, sudo, frozen, immutable, external, passthrough
    FROM models
    WHERE model_name = ? AND trashed_at IS NULL
`;

/**
 * SQL for loading fields for a model.
 *
 * WHY ORDER BY field_name: Consistent ordering for deterministic tests.
 */
const FIELDS_QUERY = `
    SELECT id, model_name, field_name, type, is_array, required, default_value,
           minimum, maximum, pattern, enum_values, relationship_type, related_model,
           related_field, relationship_name, cascade_delete, required_relationship,
           immutable, sudo, indexed, tracked, searchable, transform, description
    FROM fields
    WHERE model_name = ? AND trashed_at IS NULL
    ORDER BY field_name
`;

// =============================================================================
// MODEL CACHE CLASS
// =============================================================================

/**
 * Async model metadata cache.
 *
 * TESTABILITY: Accepts DatabaseConnection via constructor for dependency injection.
 */
export class ModelCache {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Database connection (HAL-based).
     *
     * WHY: All queries go through this connection to maintain HAL boundary.
     */
    private readonly db: DatabaseConnection;

    /**
     * Cached models.
     *
     * WHY Map: O(1) lookup by model name.
     * INVARIANT: Values are immutable Model instances.
     */
    private readonly models: Map<string, Model>;

    /**
     * Pending load requests.
     *
     * WHY: Deduplicates concurrent requests for the same model.
     * Multiple callers awaiting the same model share one database query.
     *
     * RACE CONDITION FIX: Without this, two concurrent get('file') calls
     * would both query the database, wasting resources.
     */
    private readonly pending: Map<string, Promise<Model | undefined>>;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a ModelCache.
     *
     * @param db - DatabaseConnection for HAL-based database access
     */
    constructor(db: DatabaseConnection) {
        this.db = db;
        this.models = new Map();
        this.pending = new Map();
    }

    // =========================================================================
    // CACHE ACCESS
    // =========================================================================

    /**
     * Get a model by name (async, cached).
     *
     * ALGORITHM:
     * 1. Check cache hit
     * 2. Check pending request (dedupe)
     * 3. Start new load, add to pending
     * 4. On complete: cache result, remove from pending
     * 5. Return model or undefined
     *
     * RACE CONDITION: Multiple concurrent get() calls for the same model
     * are deduplicated via the pending map.
     *
     * @param modelName - Model name (e.g., 'file', 'folder', 'invoice')
     * @returns Model or undefined if not found
     */
    async get(modelName: string): Promise<Model | undefined> {
        // Check cache first
        const cached = this.models.get(modelName);

        if (cached) {
            return cached;
        }

        // Check if already loading (dedupe concurrent requests)
        const pendingRequest = this.pending.get(modelName);

        if (pendingRequest) {
            return pendingRequest;
        }

        // Start new load
        const loadPromise = this.loadModel(modelName);

        this.pending.set(modelName, loadPromise);

        try {
            const model = await loadPromise;

            if (model) {
                this.models.set(modelName, model);
            }

            return model;
        }
        finally {
            // Always remove from pending, even on error
            this.pending.delete(modelName);
        }
    }

    /**
     * Get a model or throw if not found.
     *
     * WHY: Many operations require a model to exist. This provides
     * a convenient way to assert existence.
     *
     * @param modelName - Model name
     * @param message - Optional custom error message
     * @returns Model (never undefined)
     * @throws Error if model not found
     */
    async require(modelName: string, message?: string): Promise<Model> {
        const model = await this.get(modelName);

        if (!model) {
            throw new ENOENT(message || `Model '${modelName}' not found`);
        }

        return model;
    }

    /**
     * Check if a model exists (async).
     *
     * @param modelName - Model name
     * @returns True if model exists
     */
    async has(modelName: string): Promise<boolean> {
        const model = await this.get(modelName);

        return model !== undefined;
    }

    // =========================================================================
    // CACHE MANAGEMENT
    // =========================================================================

    /**
     * Invalidate a cached model.
     *
     * WHY: Called by observers when model definitions change.
     * Next get() will reload from database.
     *
     * @param modelName - Model name to invalidate
     */
    invalidate(modelName: string): void {
        this.models.delete(modelName);
    }

    /**
     * Clear entire cache.
     *
     * WHY: Called during testing or after bulk schema changes.
     */
    clear(): void {
        this.models.clear();
    }

    /**
     * Preload multiple models into cache.
     *
     * WHY: Batch loading at startup is more efficient than loading on demand.
     *
     * @param modelNames - Array of model names to preload
     */
    async preload(modelNames: string[]): Promise<void> {
        await Promise.all(modelNames.map(name => this.get(name)));
    }

    /**
     * Preload all system models.
     *
     * WHY: System models are needed frequently. Preloading avoids
     * database queries during normal operations.
     */
    async preloadSystemModels(): Promise<void> {
        // Meta-models only - VFS models load on-demand after VFS.init()
        await this.preload(['models', 'fields', 'tracked']);
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Load a model from database.
     *
     * ALGORITHM:
     * 1. Query models table for model row
     * 2. If not found, return undefined
     * 3. Query fields table for field rows
     * 4. Construct and return Model instance
     *
     * WHY separate method: Keeps get() logic clean and testable.
     *
     * @param modelName - Model name
     * @returns Model or undefined
     */
    private async loadModel(modelName: string): Promise<Model | undefined> {
        // Load model row
        const modelRow = await this.db.queryOne<ModelQueryResult>(MODEL_QUERY, [modelName]);

        if (!modelRow) {
            return undefined;
        }

        // Load field rows
        const fieldRows = await this.db.query<FieldQueryResult>(FIELDS_QUERY, [modelName]);

        // Construct Model
        return new Model(modelRow as ModelRow, fieldRows as FieldRow[]);
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get number of cached models.
     *
     * TESTING: Verify cache behavior.
     */
    get cacheSize(): number {
        return this.models.size;
    }

    /**
     * Get number of pending requests.
     *
     * TESTING: Verify dedupe behavior.
     */
    get pendingSize(): number {
        return this.pending.size;
    }

    /**
     * Check if model is cached (sync check).
     *
     * TESTING: Verify caching without triggering load.
     */
    isCached(modelName: string): boolean {
        return this.models.has(modelName);
    }

    /**
     * Get cached model names.
     *
     * TESTING: Verify cache contents.
     */
    getCachedModelNames(): string[] {
        return Array.from(this.models.keys());
    }
}
