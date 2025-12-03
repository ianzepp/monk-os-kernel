/**
 * EntityCache - In-memory entity index for O(1) path resolution
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * EntityCache provides fast path resolution and model dispatch by maintaining
 * an in-memory index of all entities in the system. Instead of querying the
 * database for each path component, lookups are pure Map operations.
 *
 * The cache stores minimal entity metadata:
 * - id: Entity UUID (primary key)
 * - model: Model name (determines which table has full metadata)
 * - parent: Parent entity UUID (for path traversal)
 * - name: Entity name (filename)
 *
 * This is approximately 200-250 bytes per entity. For 1 million entities,
 * the cache uses ~250-300 MB of memory - acceptable for modern systems.
 *
 * PATH RESOLUTION
 * ===============
 * ```
 * resolvePath("/home/user/docs/report.pdf")
 *     │
 *     ├─ childIndex.get("root:home")     → uuid-A
 *     ├─ childIndex.get("uuid-A:user")   → uuid-B
 *     ├─ childIndex.get("uuid-B:docs")   → uuid-C
 *     └─ childIndex.get("uuid-C:report") → uuid-D
 *
 * 4 Map lookups, zero SQL queries
 * ```
 *
 * PATH COMPUTATION
 * ================
 * ```
 * computePath("uuid-D")
 *     │
 *     ├─ byId.get("uuid-D").parent → uuid-C, name="report.pdf"
 *     ├─ byId.get("uuid-C").parent → uuid-B, name="docs"
 *     ├─ byId.get("uuid-B").parent → uuid-A, name="user"
 *     └─ byId.get("uuid-A").parent → root,   name="home"
 *
 * Walk parent chain, collect names, reverse → "/home/user/docs/report.pdf"
 * ```
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Every entity in byId has a corresponding entry in childIndex (if has parent)
 * INV-2: childIndex key format is always "parentId:name"
 * INV-3: Root entity has parent = null
 * INV-4: Cache is eventually consistent with database (sync via Ring 8 observer)
 * INV-5: Entity model field is immutable (never changes after creation)
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded, so cache mutations are atomic. However,
 * the cache may be temporarily inconsistent during observer pipeline execution:
 * - Entity is created in database (Ring 5)
 * - Entity is not yet in cache
 * - Ring 8 observer adds entity to cache
 *
 * Between Ring 5 and Ring 8, a concurrent path resolution might miss the new
 * entity. This is acceptable for two reasons:
 * 1. The same pipeline that created the entity will add it to cache
 * 2. Path resolution for newly created entities typically uses the returned ID
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: All cache mutations happen in Ring 8, after database persistence
 * RC-2: Rename/move operations update both old and new index entries atomically
 * RC-3: Delete removes from byId first, then childIndex (prevents dangling refs)
 *
 * MEMORY MANAGEMENT
 * =================
 * - Entities are plain objects (no class instances) for minimal overhead
 * - childrenOf index is optional - trade memory for readdir() performance
 * - No WeakMap - we want to keep all entities loaded
 *
 * @module model/entity-cache
 */

import type { DatabaseConnection } from './connection.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Well-known root entity ID.
 *
 * WHY fixed: Simplifies bootstrap. Root is always at this UUID.
 * Matches VFS ROOT_ID constant.
 */
export const ROOT_ID = '00000000-0000-0000-0000-000000000000';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Minimal entity metadata for path resolution.
 *
 * WHY minimal: Full entity metadata lives in model-specific tables.
 * The cache only needs enough to:
 * 1. Resolve paths (parent chain + names)
 * 2. Dispatch to correct model (model field)
 *
 * MEMORY: ~200-250 bytes per entity (strings + object overhead)
 */
export interface CachedEntity {
    /** Entity UUID */
    readonly id: string;

    /** Model name (file, folder, video, etc.) */
    readonly model: string;

    /** Parent entity UUID (null for root) */
    readonly parent: string | null;

    /** Entity name (filename) */
    readonly name: string;
}

/**
 * Entity creation input (for addEntity).
 *
 * WHY separate type: Allows parent to be undefined (will be coerced to null).
 */
export interface EntityInput {
    id: string;
    model: string;
    parent?: string | null;
    name: string;
}

/**
 * Entity update input (for updateEntity).
 *
 * WHY Partial: Only changed fields need to be provided.
 */
export interface EntityUpdate {
    parent?: string | null;
    name?: string;
}

/**
 * Statistics about cache contents.
 *
 * WHY: Monitoring and debugging.
 */
export interface CacheStats {
    /** Total entities in cache */
    entityCount: number;

    /** Total entries in child index */
    childIndexSize: number;

    /** Total parent entries in children index (if enabled) */
    childrenOfSize: number;

    /** Estimated memory usage in bytes */
    estimatedMemoryBytes: number;
}

// =============================================================================
// ENTITY CACHE CLASS
// =============================================================================

/**
 * In-memory entity index for O(1) path resolution.
 *
 * TESTABILITY: All state is inspectable via getter methods.
 */
export class EntityCache {
    // =========================================================================
    // PRIMARY INDEX
    // =========================================================================

    /**
     * Primary lookup by UUID.
     *
     * WHY Map: O(1) access to any entity's minimal metadata.
     * Key: entity UUID
     * Value: CachedEntity
     */
    private readonly byId: Map<string, CachedEntity> = new Map();

    // =========================================================================
    // SECONDARY INDEXES
    // =========================================================================

    /**
     * Child index for path resolution.
     *
     * WHY: O(1) lookup of child by parent + name.
     * Key: "parentId:childName"
     * Value: child entity UUID
     *
     * INVARIANT: Every entity with a parent has an entry here.
     */
    private readonly childIndex: Map<string, string> = new Map();

    /**
     * Optional children listing for readdir().
     *
     * WHY optional: Trade memory for readdir() performance.
     * Key: parent entity UUID
     * Value: Set of child entity UUIDs
     *
     * If not maintained, readdir() scans byId (still fast at 1M scale).
     */
    private readonly childrenOf: Map<string, Set<string>> = new Map();

    /**
     * Whether to maintain childrenOf index.
     *
     * WHY configurable: Some use cases don't need readdir().
     * Disabling saves ~20-30% memory overhead.
     */
    private readonly maintainChildrenOf: boolean;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create an EntityCache.
     *
     * @param options - Configuration options
     * @param options.maintainChildrenOf - Whether to maintain childrenOf index (default: true)
     */
    constructor(options?: { maintainChildrenOf?: boolean }) {
        this.maintainChildrenOf = options?.maintainChildrenOf ?? true;
    }

    // =========================================================================
    // BULK LOADING
    // =========================================================================

    /**
     * Load all entities from database.
     *
     * ALGORITHM:
     * 1. Query models table for all active model names
     * 2. For each model, query minimal fields from its table
     * 3. Add each entity to cache indexes
     *
     * WHY query each table: Each model has its own table. We can't do a
     * single query across all models without UNION (which would be slow).
     *
     * PERFORMANCE: ~200-500ms for 1M entities (SQLite is fast at bulk reads).
     *
     * @param db - Database connection
     */
    async loadFromDatabase(db: DatabaseConnection): Promise<void> {
        // Clear existing cache
        this.clear();

        // Get all active model names
        const models = await db.query<{ model_name: string }>(
            "SELECT model_name FROM models WHERE status IN ('system', 'active') AND trashed_at IS NULL"
        );

        // Load entities from each model's table
        for (const { model_name } of models) {
            await this.loadModelEntities(db, model_name);
        }
    }

    /**
     * Load entities from a single model's table.
     *
     * @param db - Database connection
     * @param modelName - Model name (table name)
     */
    private async loadModelEntities(db: DatabaseConnection, modelName: string): Promise<void> {
        // Skip meta-tables (they don't have parent/name columns)
        if (modelName === 'models' || modelName === 'fields' || modelName === 'tracked') {
            return;
        }

        try {
            // Query minimal fields for path resolution
            const entities = await db.query<{
                id: string;
                parent: string | null;
                name: string;
            }>(`SELECT id, parent, name FROM ${modelName} WHERE trashed_at IS NULL`);

            // Add each entity to cache
            for (const row of entities) {
                this.addEntity({
                    id: row.id,
                    model: modelName,
                    parent: row.parent,
                    name: row.name,
                });
            }
        } catch (error) {
            // Table might not exist yet (model defined but not created)
            // This is expected during bootstrap
            const err = error as Error;
            if (!err.message?.includes('no such table')) {
                throw error;
            }
        }
    }

    // =========================================================================
    // PATH RESOLUTION
    // =========================================================================

    /**
     * Resolve a path to an entity UUID.
     *
     * ALGORITHM:
     * 1. Split path into components
     * 2. Start at ROOT_ID
     * 3. For each component, lookup in childIndex
     * 4. Return final UUID or null if not found
     *
     * @param path - Absolute path (e.g., "/home/user/file.txt")
     * @returns Entity UUID or null if not found
     */
    resolvePath(path: string): string | null {
        // Handle root
        if (path === '/' || path === '') {
            return ROOT_ID;
        }

        // Split path into components
        const components = path.split('/').filter(Boolean);
        let currentId = ROOT_ID;

        for (const name of components) {
            const key = this.childKey(currentId, name);
            const childId = this.childIndex.get(key);

            if (!childId) {
                return null; // Path component not found
            }

            currentId = childId;
        }

        return currentId;
    }

    /**
     * Compute the full path for an entity.
     *
     * ALGORITHM:
     * 1. Start at entity
     * 2. Walk parent chain, collecting names
     * 3. Reverse and join with "/"
     *
     * @param id - Entity UUID
     * @returns Full path or null if entity not found
     */
    computePath(id: string): string | null {
        // Handle root
        if (id === ROOT_ID) {
            return '/';
        }

        // Check if entity exists
        let current = this.byId.get(id);
        if (!current) {
            return null; // Entity not found
        }

        const parts: string[] = [];

        while (current) {
            if (current.id === ROOT_ID) {
                break; // Reached root
            }

            parts.unshift(current.name);

            if (!current.parent) {
                break; // Orphaned entity (shouldn't happen)
            }

            current = this.byId.get(current.parent);
        }

        return '/' + parts.join('/');
    }

    /**
     * Resolve parent path and return parent UUID + child name.
     *
     * Useful for create operations where you need the parent UUID.
     *
     * @param path - Full path (e.g., "/home/user/newfile.txt")
     * @returns { parentId, name } or null if parent not found
     */
    resolveParent(path: string): { parentId: string; name: string } | null {
        const parts = path.split('/').filter(Boolean);
        if (parts.length === 0) {
            return null; // Can't get parent of root
        }

        const name = parts.pop()!;
        const parentPath = '/' + parts.join('/');
        const parentId = this.resolvePath(parentPath);

        if (!parentId) {
            return null;
        }

        return { parentId, name };
    }

    // =========================================================================
    // ENTITY LOOKUP
    // =========================================================================

    /**
     * Get entity by UUID.
     *
     * @param id - Entity UUID
     * @returns CachedEntity or undefined
     */
    getEntity(id: string): CachedEntity | undefined {
        return this.byId.get(id);
    }

    /**
     * Get model name for entity.
     *
     * @param id - Entity UUID
     * @returns Model name or undefined
     */
    getModel(id: string): string | undefined {
        return this.byId.get(id)?.model;
    }

    /**
     * Check if entity exists in cache.
     *
     * @param id - Entity UUID
     * @returns true if cached
     */
    hasEntity(id: string): boolean {
        return this.byId.has(id);
    }

    /**
     * Get child entity by parent + name.
     *
     * @param parentId - Parent entity UUID
     * @param name - Child name
     * @returns Child entity UUID or undefined
     */
    getChild(parentId: string, name: string): string | undefined {
        return this.childIndex.get(this.childKey(parentId, name));
    }

    /**
     * List children of an entity.
     *
     * @param parentId - Parent entity UUID
     * @returns Array of child entity UUIDs
     */
    listChildren(parentId: string): string[] {
        // Use childrenOf index if available
        const children = this.childrenOf.get(parentId);
        if (children) {
            return Array.from(children);
        }

        // Fall back to scanning (still fast)
        const results: string[] = [];
        for (const [id, entity] of this.byId) {
            if (entity.parent === parentId) {
                results.push(id);
            }
        }
        return results;
    }

    // =========================================================================
    // CACHE MUTATIONS
    // =========================================================================

    /**
     * Add an entity to the cache.
     *
     * Called by Ring 8 observer after entity creation.
     *
     * @param input - Entity data
     */
    addEntity(input: EntityInput): void {
        const entity: CachedEntity = {
            id: input.id,
            model: input.model,
            parent: input.parent ?? null,
            name: input.name,
        };

        // Add to primary index
        this.byId.set(entity.id, entity);

        // Add to child index (if has parent)
        if (entity.parent) {
            this.childIndex.set(this.childKey(entity.parent, entity.name), entity.id);

            // Add to childrenOf index (if enabled)
            if (this.maintainChildrenOf) {
                let siblings = this.childrenOf.get(entity.parent);
                if (!siblings) {
                    siblings = new Set();
                    this.childrenOf.set(entity.parent, siblings);
                }
                siblings.add(entity.id);
            }
        }
    }

    /**
     * Update an entity in the cache.
     *
     * Handles rename and move (parent change) operations.
     * Called by Ring 8 observer after entity update.
     *
     * @param id - Entity UUID
     * @param changes - Changed fields
     */
    updateEntity(id: string, changes: EntityUpdate): void {
        const existing = this.byId.get(id);
        if (!existing) {
            return; // Entity not in cache (shouldn't happen)
        }

        // Handle rename
        if (changes.name !== undefined && changes.name !== existing.name) {
            // Remove old child index entry
            if (existing.parent) {
                this.childIndex.delete(this.childKey(existing.parent, existing.name));
            }

            // Create updated entity (immutable update)
            const updated: CachedEntity = {
                ...existing,
                name: changes.name,
            };
            this.byId.set(id, updated);

            // Add new child index entry
            if (updated.parent) {
                this.childIndex.set(this.childKey(updated.parent, updated.name), id);
            }

            return; // Name changed, skip parent change handling
        }

        // Handle move (parent change)
        if (changes.parent !== undefined && changes.parent !== existing.parent) {
            // Remove from old parent's indexes
            if (existing.parent) {
                this.childIndex.delete(this.childKey(existing.parent, existing.name));

                if (this.maintainChildrenOf) {
                    this.childrenOf.get(existing.parent)?.delete(id);
                }
            }

            // Create updated entity
            const updated: CachedEntity = {
                ...existing,
                parent: changes.parent ?? null,
            };
            this.byId.set(id, updated);

            // Add to new parent's indexes
            if (updated.parent) {
                this.childIndex.set(this.childKey(updated.parent, updated.name), id);

                if (this.maintainChildrenOf) {
                    let siblings = this.childrenOf.get(updated.parent);
                    if (!siblings) {
                        siblings = new Set();
                        this.childrenOf.set(updated.parent, siblings);
                    }
                    siblings.add(id);
                }
            }
        }
    }

    /**
     * Remove an entity from the cache.
     *
     * Called by Ring 8 observer after entity deletion.
     *
     * @param id - Entity UUID
     */
    removeEntity(id: string): void {
        const existing = this.byId.get(id);
        if (!existing) {
            return; // Already removed
        }

        // Remove from byId first (prevents dangling refs)
        this.byId.delete(id);

        // Remove from child index
        if (existing.parent) {
            this.childIndex.delete(this.childKey(existing.parent, existing.name));

            // Remove from childrenOf index
            if (this.maintainChildrenOf) {
                this.childrenOf.get(existing.parent)?.delete(id);
            }
        }

        // Remove childrenOf entry for this entity (if it had children)
        if (this.maintainChildrenOf) {
            this.childrenOf.delete(id);
        }
    }

    /**
     * Clear all cached entities.
     */
    clear(): void {
        this.byId.clear();
        this.childIndex.clear();
        this.childrenOf.clear();
    }

    // =========================================================================
    // STATISTICS
    // =========================================================================

    /**
     * Get cache statistics.
     *
     * @returns Cache stats
     */
    getStats(): CacheStats {
        const entityCount = this.byId.size;
        const childIndexSize = this.childIndex.size;
        const childrenOfSize = this.childrenOf.size;

        // Estimate memory: ~250 bytes per entity + index overhead
        const estimatedMemoryBytes =
            entityCount * 250 + // byId entries
            childIndexSize * 100 + // childIndex entries (key + value)
            childrenOfSize * 50; // childrenOf entries (key + Set overhead)

        return {
            entityCount,
            childIndexSize,
            childrenOfSize,
            estimatedMemoryBytes,
        };
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get total entity count.
     */
    get size(): number {
        return this.byId.size;
    }

    /**
     * Get all entity IDs.
     */
    getAllIds(): string[] {
        return Array.from(this.byId.keys());
    }

    /**
     * Get all entities.
     */
    getAllEntities(): CachedEntity[] {
        return Array.from(this.byId.values());
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Build child index key.
     *
     * @param parentId - Parent entity UUID
     * @param name - Child name
     * @returns Index key "parentId:name"
     */
    private childKey(parentId: string, name: string): string {
        return `${parentId}:${name}`;
    }
}
