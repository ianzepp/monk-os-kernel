/**
 * PathCache - In-memory path resolution cache for O(1) lookups
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * PathCache provides fast path resolution and model dispatch by maintaining
 * an in-memory index of path entries. Instead of querying the database for
 * each path component, lookups are pure Map operations.
 *
 * The cache stores minimal path entry metadata:
 * - id: Entity UUID (primary key)
 * - model: Model name (determines which table has full metadata)
 * - parent: Parent entity UUID (for path traversal)
 * - pathname: VFS path component (derived from model's pathname field)
 *
 * This is approximately 200-250 bytes per entry. For 1 million entities,
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
 *     ├─ byId.get("uuid-D").parent → uuid-C, pathname="report.pdf"
 *     ├─ byId.get("uuid-C").parent → uuid-B, pathname="docs"
 *     ├─ byId.get("uuid-B").parent → uuid-A, pathname="user"
 *     └─ byId.get("uuid-A").parent → root,   pathname="home"
 *
 * Walk parent chain, collect pathnames, reverse → "/home/user/docs/report.pdf"
 * ```
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Every entry in byId has a corresponding entry in childIndex (if has parent)
 * INV-2: childIndex key format is always "parentId:pathname"
 * INV-3: Root entity has parent = null
 * INV-4: Cache is eventually consistent with database (sync via Ring 8 observer)
 * INV-5: Entry model field is immutable (never changes after creation)
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
 * - Entries are plain objects (no class instances) for minimal overhead
 * - childrenOf index is optional - trade memory for readdir() performance
 * - No WeakMap - we want to keep all entries loaded
 *
 * @module vfs/path-cache
 */

import type { DatabaseConnection } from '../ems/connection.js';

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
 * Minimal path entry metadata for path resolution.
 *
 * WHY minimal: Full entity metadata lives in model-specific tables.
 * The cache only needs enough to:
 * 1. Resolve paths (parent chain + names)
 * 2. Dispatch to correct model (model field)
 *
 * MEMORY: ~200-250 bytes per entry (strings + object overhead)
 */
export interface PathEntry {
    /** Entity UUID */
    readonly id: string;

    /** Model name (file, folder, video, etc.) */
    readonly model: string;

    /** Parent entity UUID (null for root) */
    readonly parent: string | null;

    /** VFS path component (derived from models.pathname field) */
    readonly pathname: string;
}

/**
 * Path entry creation input (for addEntry).
 *
 * WHY separate type: Allows parent to be undefined (will be coerced to null).
 */
export interface PathEntryInput {
    id: string;
    model: string;
    parent?: string | null;
    pathname: string;
}

/**
 * Path entry update input (for updateEntry).
 *
 * WHY Partial: Only changed fields need to be provided.
 */
export interface PathEntryUpdate {
    parent?: string | null;
    pathname?: string;
}

/**
 * Statistics about cache contents.
 *
 * WHY: Monitoring and debugging.
 */
export interface PathCacheStats {
    /** Total entries in cache */
    entryCount: number;

    /** Total entries in child index */
    childIndexSize: number;

    /** Total parent entries in children index (if enabled) */
    childrenOfSize: number;

    /** Estimated memory usage in bytes */
    estimatedMemoryBytes: number;
}

// =============================================================================
// PATH CACHE CLASS
// =============================================================================

/**
 * In-memory path resolution cache for O(1) lookups.
 *
 * TESTABILITY: All state is inspectable via getter methods.
 */
export class PathCache {
    // =========================================================================
    // PRIMARY INDEX
    // =========================================================================

    /**
     * Primary lookup by UUID.
     *
     * WHY Map: O(1) access to any entry's minimal metadata.
     * Key: entity UUID
     * Value: PathEntry
     */
    private readonly byId: Map<string, PathEntry> = new Map();

    // =========================================================================
    // SECONDARY INDEXES
    // =========================================================================

    /**
     * Child index for path resolution.
     *
     * WHY: O(1) lookup of child by parent + pathname.
     * Key: "parentId:childPathname"
     * Value: child entity UUID
     *
     * INVARIANT: Every entry with a parent has an entry here.
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
     * Create a PathCache.
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
     * Load all entities from the entities table.
     *
     * ALGORITHM:
     * 1. Query entities table for all active entities
     * 2. Add each entity to cache indexes
     *
     * WHY single table: The entities table is the single source of truth for
     * entity identity and hierarchy. Model-specific details live in separate
     * detail tables, but the cache only needs id, model, parent, name.
     *
     * PERFORMANCE: Single query, ~100-300ms for 1M entities.
     *
     * @param db - Database connection
     */
    async loadFromDatabase(db: DatabaseConnection): Promise<void> {
        // Clear existing cache
        this.clear();

        // Load all entities from the entities table
        // Note: entities table has no trashed_at - cache contains ALL entities.
        // Soft-delete status is determined by the detail table's trashed_at.
        const entities = await db.query<PathEntry>(
            'SELECT id, model, parent, pathname FROM entities',
        );

        // Add each entity to cache
        for (const entity of entities) {
            this.addEntry(entity);
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
     * 4. On cache miss, fallback to database (if db provided)
     * 5. Return final UUID or null if not found
     *
     * WHY async: Allows database fallback on cache miss. When cache hits,
     * the async overhead is negligible (single-digit microseconds).
     *
     * WHY optional db: Backward compatible. Without db, behaves like before
     * (cache-only, returns null on miss).
     *
     * @param path - Absolute path (e.g., "/home/user/file.txt")
     * @param db - Optional database connection for fallback queries
     * @returns Entity UUID or null if not found
     */
    async resolvePath(path: string, db?: DatabaseConnection): Promise<string | null> {
        // Handle root
        if (path === '/' || path === '') {
            return ROOT_ID;
        }

        // Split path into components
        const components = path.split('/').filter(Boolean);
        let currentId = ROOT_ID;

        for (const pathname of components) {
            const key = this.childKey(currentId, pathname);
            let childId = this.childIndex.get(key);

            // Cache miss - try database fallback
            if (!childId && db) {
                childId = await this.resolveFromDatabase(db, currentId, pathname);
            }

            if (!childId) {
                return null; // Path component not found
            }

            currentId = childId;
        }

        return currentId;
    }

    /**
     * Fallback: resolve single path component from database.
     *
     * WHY private: Only used internally when cache misses.
     * WHY populate cache: Future lookups for same path are O(1).
     *
     * @param db - Database connection
     * @param parentId - Parent entity UUID
     * @param pathname - Child pathname to find
     * @returns Child entity UUID or undefined if not found
     */
    private async resolveFromDatabase(
        db: DatabaseConnection,
        parentId: string,
        pathname: string,
    ): Promise<string | undefined> {
        const rows = await db.query<PathEntry>(
            'SELECT id, model, parent, pathname FROM entities WHERE parent = ? AND pathname = ?',
            [parentId, pathname],
        );

        const entity = rows[0];

        if (!entity) {
            return undefined;
        }

        // Populate cache for future lookups
        this.addEntry(entity);

        return entity.id;
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

            parts.unshift(current.pathname);

            if (!current.parent) {
                break; // Orphaned entity (shouldn't happen)
            }

            current = this.byId.get(current.parent);
        }

        return '/' + parts.join('/');
    }

    /**
     * Resolve parent path and return parent UUID + child pathname.
     *
     * Useful for create operations where you need the parent UUID.
     *
     * @param path - Full path (e.g., "/home/user/newfile.txt")
     * @param db - Optional database connection for fallback queries
     * @returns { parentId, pathname } or null if parent not found
     */
    async resolveParent(
        path: string,
        db?: DatabaseConnection,
    ): Promise<{ parentId: string; pathname: string } | null> {
        const parts = path.split('/').filter(Boolean);

        if (parts.length === 0) {
            return null; // Can't get parent of root
        }

        const pathname = parts.pop()!;
        const parentPath = '/' + parts.join('/');
        const parentId = await this.resolvePath(parentPath, db);

        if (!parentId) {
            return null;
        }

        return { parentId, pathname };
    }

    // =========================================================================
    // ENTRY LOOKUP
    // =========================================================================

    /**
     * Get entry by UUID.
     *
     * @param id - Entity UUID
     * @returns PathEntry or undefined
     */
    getEntry(id: string): PathEntry | undefined {
        return this.byId.get(id);
    }

    /**
     * Get model name for entry.
     *
     * @param id - Entity UUID
     * @returns Model name or undefined
     */
    getModel(id: string): string | undefined {
        return this.byId.get(id)?.model;
    }

    /**
     * Check if entry exists in cache.
     *
     * @param id - Entity UUID
     * @returns true if cached
     */
    hasEntry(id: string): boolean {
        return this.byId.has(id);
    }

    /**
     * Get child entry by parent + pathname.
     *
     * @param parentId - Parent entity UUID
     * @param pathname - Child pathname
     * @returns Child entity UUID or undefined
     */
    getChild(parentId: string, pathname: string): string | undefined {
        return this.childIndex.get(this.childKey(parentId, pathname));
    }

    /**
     * List children of an entry.
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

        for (const [id, entry] of this.byId) {
            if (entry.parent === parentId) {
                results.push(id);
            }
        }

        return results;
    }

    // =========================================================================
    // CACHE MUTATIONS
    // =========================================================================

    /**
     * Add an entry to the cache.
     *
     * Called by Ring 8 observer after entity creation.
     *
     * @param input - Entry data
     */
    addEntry(input: PathEntryInput): void {
        const entry: PathEntry = {
            id: input.id,
            model: input.model,
            parent: input.parent ?? null,
            pathname: input.pathname,
        };

        // Add to primary index
        this.byId.set(entry.id, entry);

        // Add to child index (if has parent)
        if (entry.parent) {
            this.childIndex.set(this.childKey(entry.parent, entry.pathname), entry.id);

            // Add to childrenOf index (if enabled)
            if (this.maintainChildrenOf) {
                let siblings = this.childrenOf.get(entry.parent);

                if (!siblings) {
                    siblings = new Set();
                    this.childrenOf.set(entry.parent, siblings);
                }

                siblings.add(entry.id);
            }
        }
    }

    /**
     * Update an entry in the cache.
     *
     * Handles rename and move (parent change) operations.
     * Called by Ring 8 observer after entity update.
     *
     * @param id - Entity UUID
     * @param changes - Changed fields
     */
    updateEntry(id: string, changes: PathEntryUpdate): void {
        const existing = this.byId.get(id);

        if (!existing) {
            return; // Entry not in cache (shouldn't happen)
        }

        // Handle rename
        if (changes.pathname !== undefined && changes.pathname !== existing.pathname) {
            // Remove old child index entry
            if (existing.parent) {
                this.childIndex.delete(this.childKey(existing.parent, existing.pathname));
            }

            // Create updated entry (immutable update)
            const updated: PathEntry = {
                ...existing,
                pathname: changes.pathname,
            };

            this.byId.set(id, updated);

            // Add new child index entry
            if (updated.parent) {
                this.childIndex.set(this.childKey(updated.parent, updated.pathname), id);
            }

            return; // Pathname changed, skip parent change handling
        }

        // Handle move (parent change)
        if (changes.parent !== undefined && changes.parent !== existing.parent) {
            // Remove from old parent's indexes
            if (existing.parent) {
                this.childIndex.delete(this.childKey(existing.parent, existing.pathname));

                if (this.maintainChildrenOf) {
                    this.childrenOf.get(existing.parent)?.delete(id);
                }
            }

            // Create updated entry
            const updated: PathEntry = {
                ...existing,
                parent: changes.parent ?? null,
            };

            this.byId.set(id, updated);

            // Add to new parent's indexes
            if (updated.parent) {
                this.childIndex.set(this.childKey(updated.parent, updated.pathname), id);

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
     * Remove an entry from the cache.
     *
     * Called by Ring 8 observer after entity deletion.
     *
     * @param id - Entity UUID
     */
    removeEntry(id: string): void {
        const existing = this.byId.get(id);

        if (!existing) {
            return; // Already removed
        }

        // Remove from byId first (prevents dangling refs)
        this.byId.delete(id);

        // Remove from child index
        if (existing.parent) {
            this.childIndex.delete(this.childKey(existing.parent, existing.pathname));

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
     * Clear all cached entries.
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
    getStats(): PathCacheStats {
        const entryCount = this.byId.size;
        const childIndexSize = this.childIndex.size;
        const childrenOfSize = this.childrenOf.size;

        // Estimate memory: ~250 bytes per entry + index overhead
        const estimatedMemoryBytes =
            entryCount * 250 + // byId entries
            childIndexSize * 100 + // childIndex entries (key + value)
            childrenOfSize * 50; // childrenOf entries (key + Set overhead)

        return {
            entryCount,
            childIndexSize,
            childrenOfSize,
            estimatedMemoryBytes,
        };
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get total entry count.
     */
    get size(): number {
        return this.byId.size;
    }

    /**
     * Get all entry IDs.
     */
    getAllIds(): string[] {
        return Array.from(this.byId.keys());
    }

    /**
     * Get all entries.
     */
    getAllEntries(): PathEntry[] {
        return Array.from(this.byId.values());
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Build child index key.
     *
     * @param parentId - Parent entity UUID
     * @param pathname - Child pathname
     * @returns Index key "parentId:pathname"
     */
    private childKey(parentId: string, pathname: string): string {
        return `${parentId}:${pathname}`;
    }
}
