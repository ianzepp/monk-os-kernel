/**
 * Namespace Cache - Per-namespace model and field caching
 *
 * Provides schema-aware caching that isolates tenant data properly.
 * Replaces the schema-blind ModelCache and RelationshipCache.
 *
 * Part of the namespace cache refactor (Phase 2).
 */

import { Field, type FieldRow } from '@src/lib/field.js';
import { Model } from '@src/lib/model.js';
import type { SystemContext } from '@src/lib/system-context-types.js';

/**
 * Singleton manager that holds all namespace caches.
 * Returns bound NamespaceCache instances for use in per-request System context.
 */
export class NamespaceCacheManager {
    private static instance: NamespaceCacheManager;
    private caches = new Map<string, NamespaceCache>();

    private constructor() {}

    static getInstance(): NamespaceCacheManager {
        if (!NamespaceCacheManager.instance) {
            NamespaceCacheManager.instance = new NamespaceCacheManager();
        }
        return NamespaceCacheManager.instance;
    }

    /**
     * Get or create namespace cache
     * Called once per request in System constructor
     */
    getNamespaceCache(db: string, ns: string): NamespaceCache {
        const key = this.getCacheKey(db, ns);

        if (!this.caches.has(key)) {
            this.caches.set(key, new NamespaceCache(db, ns));
            console.info('NamespaceCache created', { db, ns, key });
        }

        return this.caches.get(key)!;
    }

    /**
     * Cache key: "db:ns"
     */
    private getCacheKey(db: string, ns: string): string {
        return `${db}:${ns}`;
    }

    /**
     * Get cache statistics for debugging
     */
    getCacheStats(): Record<string, { modelCount: number; fieldCount: number; loaded: boolean }> {
        const stats: Record<string, { modelCount: number; fieldCount: number; loaded: boolean }> = {};

        for (const [key, cache] of this.caches.entries()) {
            stats[key] = {
                modelCount: cache.getModelCount(),
                fieldCount: cache.getFieldCount(),
                loaded: cache.isLoaded(),
            };
        }

        return stats;
    }

    /**
     * Clear all caches (for testing)
     */
    clearAll(): void {
        this.caches.clear();
        console.info('All namespace caches cleared');
    }
}

/**
 * Per-namespace cache bound to a specific db:ns.
 * Stored on System for the request lifecycle - no need to pass db/ns repeatedly.
 *
 * Loading vs Reading:
 * - Load operations (loadAll, loadOne) require tx and hit the database
 * - Read operations (getModel, getRelationships) are pure cache reads, no tx needed
 * - Invalidation clears cache entries, then loadOne() is called to repopulate
 */
export class NamespaceCache {
    readonly db: string;
    readonly ns: string;

    // Internal storage
    private models = new Map<string, Model>();              // key: model_name
    private fields = new Map<string, Field>();              // key: "model_name:field_name"
    private relationships = new Map<string, Field[]>();     // key: "parent_model:relationship_name"

    // Loading state
    private loaded = false;
    private loading: Promise<void> | null = null;           // Semaphore for concurrent loads
    private loadedAt: number = 0;

    constructor(db: string, ns: string) {
        this.db = db;
        this.ns = ns;
    }

    // === Load operations (require tx) ===

    /**
     * Initial load - all models + fields for namespace (one-time penalty per tenant)
     * Uses semaphore to prevent duplicate loads from concurrent requests
     */
    async loadAll(system: SystemContext): Promise<void> {
        // Already loaded
        if (this.loaded) {
            return;
        }

        // Another request is loading - wait for it
        if (this.loading) {
            await this.loading;
            return;
        }

        // First request - do the load
        this.loading = this.doLoadAll(system);
        try {
            await this.loading;
            this.loaded = true;
            this.loadedAt = Date.now();
        } finally {
            this.loading = null;
        }
    }

    /**
     * Actual database queries and cache population
     */
    private async doLoadAll(system: SystemContext): Promise<void> {
        // Use adapter (supports both PostgreSQL and SQLite)
        const adapter = system.adapter;
        if (!adapter) {
            throw new Error('NamespaceCache.doLoadAll: No adapter available on system context');
        }

        // Load all active/system models
        const modelResult = await adapter.query(`
            SELECT *
            FROM models
            WHERE status IN ('active', 'system')
              AND trashed_at IS NULL
              AND deleted_at IS NULL
        `);

        // Load all fields for active models
        const fieldResult = await adapter.query(`
            SELECT f.*
            FROM fields f
            INNER JOIN models m ON f.model_name = m.model_name
            WHERE m.status IN ('active', 'system')
              AND m.trashed_at IS NULL
              AND m.deleted_at IS NULL
              AND f.trashed_at IS NULL
              AND f.deleted_at IS NULL
        `);

        // Group fields by model
        const fieldsByModel = new Map<string, FieldRow[]>();
        for (const row of fieldResult.rows as unknown as FieldRow[]) {
            const fields = fieldsByModel.get(row.model_name) || [];
            fields.push(row);
            fieldsByModel.set(row.model_name, fields);
        }

        // Build each model, isolating failures
        for (const modelRow of modelResult.rows as any[]) {
            try {
                const fieldRows = fieldsByModel.get(modelRow.model_name) || [];
                const fieldsMap = new Map<string, Field>();

                // Build Field objects and store in both maps
                for (const fieldRow of fieldRows) {
                    const field = new Field(fieldRow);
                    fieldsMap.set(field.fieldName, field);
                    this.fields.set(field.key, field);
                }

                // Build Model with Field map
                const model = new Model(system, modelRow.model_name, {
                    ...modelRow,
                    _fields: fieldRows,
                });

                this.models.set(modelRow.model_name, model);

            } catch (error) {
                console.error(`Failed to load model '${modelRow.model_name}'`, {
                    error: error instanceof Error ? error.message : String(error),
                });
                // Continue loading other models
            }
        }

        // Build relationships index
        this.rebuildRelationships();

        console.info('NamespaceCache loaded', {
            db: this.db,
            ns: this.ns,
            models: this.models.size,
            fields: this.fields.size,
            relationships: this.relationships.size,
        });
    }

    /**
     * Reload single model after invalidation
     */
    async loadOne(system: SystemContext, modelName: string): Promise<void> {
        // Use adapter (supports both PostgreSQL and SQLite)
        const adapter = system.adapter;
        if (!adapter) {
            throw new Error('NamespaceCache.loadOne: No adapter available on system context');
        }

        // Load model
        const modelResult = await adapter.query(`
            SELECT *
            FROM models
            WHERE model_name = $1
              AND status IN ('active', 'system')
              AND trashed_at IS NULL
              AND deleted_at IS NULL
        `, [modelName]);

        if (modelResult.rows.length === 0) {
            // Model deleted or trashed - ensure it's removed from cache
            this.models.delete(modelName);
            // Remove all fields for this model
            for (const [key, field] of this.fields.entries()) {
                if (field.modelName === modelName) {
                    this.fields.delete(key);
                }
            }
            this.rebuildRelationships();
            console.info('Model removed from cache', { modelName });
            return;
        }

        const modelRow = modelResult.rows[0] as any;

        // Load fields for this model
        const fieldResult = await adapter.query(`
            SELECT *
            FROM fields
            WHERE model_name = $1
              AND trashed_at IS NULL
              AND deleted_at IS NULL
        `, [modelName]);

        // Remove old fields for this model
        for (const [key, field] of this.fields.entries()) {
            if (field.modelName === modelName) {
                this.fields.delete(key);
            }
        }

        // Build new Field objects
        const fieldRows = fieldResult.rows as unknown as FieldRow[];
        const fieldsMap = new Map<string, Field>();

        for (const fieldRow of fieldRows) {
            const field = new Field(fieldRow);
            fieldsMap.set(field.fieldName, field);
            this.fields.set(field.key, field);
        }

        // Build Model with Field map
        const model = new Model(system, modelRow.model_name, {
            ...modelRow,
            _fields: fieldRows,
        });

        this.models.set(modelName, model);

        // Rebuild relationships
        this.rebuildRelationships();

        console.info('Model reloaded into cache', {
            modelName,
            fieldCount: fieldRows.length,
        });
    }

    /**
     * Check if initial load completed
     */
    isLoaded(): boolean {
        return this.loaded;
    }

    // === Read operations (no tx needed) ===

    /**
     * Get model by name - throws if not loaded or not found
     */
    getModel(modelName: string): Model {
        if (!this.loaded) {
            throw new Error(`NamespaceCache not loaded for ${this.db}:${this.ns}. loadAll() must be called first.`);
        }

        const model = this.models.get(modelName);
        if (!model) {
            throw new Error(`Model '${modelName}' not found in namespace ${this.db}:${this.ns}`);
        }

        return model;
    }

    /**
     * Check if model exists (without throwing)
     */
    hasModel(modelName: string): boolean {
        return this.models.has(modelName);
    }

    /**
     * Get field by model and field name
     */
    getField(modelName: string, fieldName: string): Field | undefined {
        const key = `${modelName}:${fieldName}`;
        return this.fields.get(key);
    }

    /**
     * Get all fields for a model
     */
    getFieldsForModel(modelName: string): Field[] {
        const result: Field[] = [];
        for (const field of this.fields.values()) {
            if (field.modelName === modelName) {
                result.push(field);
            }
        }
        return result;
    }

    /**
     * Get relationships by parent model and relationship name
     * Returns array of Field objects (handles one-to-many)
     */
    getRelationships(parentModel: string, relationshipName: string): Field[] {
        const key = `${parentModel}:${relationshipName}`;
        return this.relationships.get(key) || [];
    }

    /**
     * Get all relationships for a parent model
     */
    getRelationshipsForModel(parentModel: string): Map<string, Field[]> {
        const result = new Map<string, Field[]>();

        for (const [key, fields] of this.relationships.entries()) {
            if (key.startsWith(`${parentModel}:`)) {
                const relationshipName = key.substring(parentModel.length + 1);
                result.set(relationshipName, fields);
            }
        }

        return result;
    }

    // === Invalidation ===

    /**
     * Invalidate model in cache - should be followed by loadOne()
     */
    invalidateModel(modelName: string): void {
        this.models.delete(modelName);

        // Remove all fields for this model
        for (const [key, field] of this.fields.entries()) {
            if (field.modelName === modelName) {
                this.fields.delete(key);
            }
        }

        // Rebuild relationships
        this.rebuildRelationships();

        console.info('Model invalidated from cache', {
            db: this.db,
            ns: this.ns,
            modelName,
        });
    }

    // === Internal helpers ===

    /**
     * Rebuild relationships index from current fields
     */
    private rebuildRelationships(): void {
        this.relationships.clear();

        for (const field of this.fields.values()) {
            if (field.hasRelationship()) {
                const key = field.relationshipKey!;
                const existing = this.relationships.get(key) || [];
                existing.push(field);
                this.relationships.set(key, existing);
            }
        }
    }

    /**
     * Get model count for stats
     */
    getModelCount(): number {
        return this.models.size;
    }

    /**
     * Get field count for stats
     */
    getFieldCount(): number {
        return this.fields.size;
    }

    /**
     * Get load timestamp
     */
    getLoadedAt(): number {
        return this.loadedAt;
    }
}
