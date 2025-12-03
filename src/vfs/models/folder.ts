/**
 * FolderModel - Organizational container for files and other folders
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * FolderModel implements directory semantics for Monk OS. Unlike files, folders
 * have no data blob - they exist purely as organizational containers. Child
 * entities are found by querying for entities whose 'parent' field matches the
 * folder's UUID.
 *
 * This parent-pointer design (vs. child-list design) simplifies rename and move
 * operations: only the moved entity's parent field needs updating. However, it
 * makes listing children O(n) where n is total entities, since we must scan all
 * entities to find those with matching parent. For large filesystems, an index
 * on parent would be essential.
 *
 * Folders cannot be opened for I/O - attempting to open() throws EISDIR. This
 * matches POSIX semantics where directories are read via readdir(), not read().
 *
 * STATE MACHINE
 * =============
 * Folders have no handle state. They exist or don't exist.
 *
 *   create() ──────────> EXISTS ──────────> (deleted)
 *                          │                    ^
 *                          │ unlink()           │
 *                          │ (only if empty)    │
 *                          └────────────────────┘
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: folder.size is always 0 (folders have no intrinsic size)
 * INV-2: folder.data is always undefined (no data blob)
 * INV-3: Folders can only be deleted when empty (no children)
 * INV-4: ctime is set once at creation and never modified
 * INV-5: mtime is updated on metadata changes (NOT on child changes)
 * INV-6: Root folder has parent = null
 *
 * CONCURRENCY MODEL
 * =================
 * Folder operations are atomic at the storage layer. The list() operation
 * provides a snapshot view - entities created during iteration may or may
 * not be included. Delete checks for emptiness, but a concurrent create()
 * could add a child between the check and delete - this would orphan the
 * child. Production systems should use advisory locking on folder deletion.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Empty check before delete (TOCTOU vulnerable - see above)
 * RC-2: Storage operations are individually atomic
 *
 * MEMORY MANAGEMENT
 * =================
 * - list() yields entity IDs lazily via async iterator
 * - No buffering of child entities (streaming enumeration)
 * - Watch events are yielded as they arrive (no queuing)
 *
 * @module vfs/models/folder
 */

import { PosixModel } from '@src/vfs/model.js';
import type { ModelStat, ModelContext, FieldDef, WatchEvent } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import { EISDIR, ENOENT, ENOTEMPTY } from '@src/hal/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Storage key prefix for entity metadata.
 * WHY: Consistent with other models; enables namespace partitioning.
 */
const ENTITY_PREFIX = 'entity:';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Schema definition for folder entities.
 *
 * TESTABILITY: Exported constant allows tests to verify schema structure.
 *
 * Note: 'parent' is not required because root folder has parent = null.
 *
 * Fields:
 * - id: UUID of the folder entity
 * - model: Always 'folder' for this model
 * - name: Folder name (not full path)
 * - parent: UUID of parent folder (null for root)
 * - owner: UUID of creating process/user
 * - mtime: Last modification timestamp
 * - ctime: Creation timestamp
 */
const FOLDER_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'parent', type: 'string' }, // Not required - root has null parent
    { name: 'owner', type: 'string', required: true },
    { name: 'mtime', type: 'number', required: true },
    { name: 'ctime', type: 'number', required: true },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Decode a Uint8Array to a JSON object.
 *
 * WHY: Centralizes JSON deserialization with proper typing.
 *
 * @param data - Raw bytes to decode
 * @returns Parsed JSON object
 */
function decodeEntity<T>(data: Uint8Array): T {
    return JSON.parse(new TextDecoder().decode(data)) as T;
}

/**
 * Encode a JSON object to a Uint8Array.
 *
 * WHY: Centralizes JSON serialization for storage.
 *
 * @param entity - Object to encode
 * @returns Encoded bytes
 */
function encodeEntity(entity: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(entity));
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * FolderModel - Directory container model.
 *
 * Implements organizational hierarchy for the VFS. Folders contain
 * other entities (files, folders, devices) via parent-pointer relationship.
 */
export class FolderModel extends PosixModel {
    // =========================================================================
    // MODEL IDENTITY
    // =========================================================================

    /**
     * Model identifier.
     *
     * WHY: Used by VFS to dispatch operations to the correct model.
     * INVARIANT: Always 'folder' for this model.
     */
    readonly name = 'folder';

    // =========================================================================
    // SCHEMA
    // =========================================================================

    /**
     * Return field definitions for folder entities.
     *
     * WHY: Enables schema validation and introspection.
     *
     * @returns Array of field definitions
     */
    fields(): FieldDef[] {
        return FOLDER_FIELDS;
    }

    // =========================================================================
    // CORE OPERATIONS
    // =========================================================================

    /**
     * Open a folder for I/O operations.
     *
     * WHY this throws: Folders are not file-like. In POSIX, directories
     * are enumerated via readdir() not read(). Use list() instead.
     *
     * @throws EISDIR - Always (folders cannot be opened for I/O)
     */
    async open(
        _ctx: ModelContext,
        _id: string,
        _flags: OpenFlags,
        _opts?: OpenOptions
    ): Promise<FileHandle> {
        throw new EISDIR('Cannot open folder for I/O');
    }

    /**
     * Get metadata for a folder.
     *
     * WHY size is always 0:
     * Folders have no intrinsic size. Some systems report block size
     * or child count, but we report 0 for simplicity.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @returns Entity metadata with size=0
     * @throws ENOENT - If folder does not exist
     */
    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`Folder not found: ${id}`);
        }

        const entity = decodeEntity<ModelStat>(data);
        return {
            ...entity,
            size: 0, // Folders have no size
        };
    }

    /**
     * Update metadata fields on a folder.
     *
     * ALGORITHM:
     * 1. Load existing entity
     * 2. Merge allowed fields (name, parent only)
     * 3. Update mtime
     * 4. Write back to storage
     *
     * WHY only name and parent are updatable:
     * - id, model, ctime are immutable by design
     * - owner changes would require permission escalation checks
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param fields - Fields to update
     * @throws ENOENT - If folder does not exist
     */
    async setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`Folder not found: ${id}`);
        }

        const entity = decodeEntity<ModelStat>(data);

        // Update allowed fields only
        if (fields.name !== undefined) entity.name = fields.name;
        if (fields.parent !== undefined) entity.parent = fields.parent;

        // Always update mtime on metadata change
        entity.mtime = ctx.hal.clock.now();

        await ctx.hal.storage.put(`${ENTITY_PREFIX}${id}`, encodeEntity(entity));
    }

    /**
     * Create a new folder.
     *
     * ALGORITHM:
     * 1. Generate UUID for entity
     * 2. Create entity with metadata
     * 3. Return entity UUID
     *
     * WHY no data blob: Folders have no content. Children are found
     * by querying for entities with parent = this folder's ID.
     *
     * @param ctx - Model context
     * @param parent - Parent folder UUID
     * @param name - Folder name
     * @param fields - Optional initial field values
     * @returns Created entity UUID
     */
    async create(
        ctx: ModelContext,
        parent: string,
        name: string,
        fields?: Partial<ModelStat>
    ): Promise<string> {
        const id = ctx.hal.entropy.uuid();
        const now = ctx.hal.clock.now();

        const entity: ModelStat = {
            id,
            model: 'folder',
            name,
            parent,
            owner: fields?.owner ?? ctx.caller,
            size: 0, // Folders have no size
            mtime: now,
            ctime: now,
        };

        await ctx.hal.storage.put(`${ENTITY_PREFIX}${id}`, encodeEntity(entity));

        return id;
    }

    /**
     * Delete a folder.
     *
     * ALGORITHM:
     * 1. Check if folder has any children
     * 2. If not empty, throw ENOTEMPTY
     * 3. Delete entity from storage
     *
     * RACE CONDITION (TOCTOU):
     * A concurrent create() could add a child between our empty check
     * and the actual delete. This would orphan the child entity. The
     * child would still exist but its parent pointer would reference
     * a non-existent folder.
     *
     * Mitigation options (not implemented):
     * - Advisory locking on folder deletion
     * - Transactional storage with foreign key constraints
     * - Garbage collection of orphaned entities
     *
     * @param ctx - Model context
     * @param id - Entity UUID to delete
     * @throws ENOTEMPTY - If folder contains children
     */
    async unlink(ctx: ModelContext, id: string): Promise<void> {
        // Check if folder is empty by scanning for any child
        let hasChildren = false;
        for await (const _child of this.list(ctx, id)) {
            hasChildren = true;
            break; // Only need to find one child to know it's not empty
        }

        if (hasChildren) {
            throw new ENOTEMPTY(`Folder not empty: ${id}`);
        }

        // Delete entity metadata
        await ctx.hal.storage.delete(`${ENTITY_PREFIX}${id}`);
    }

    /**
     * List children of a folder.
     *
     * ALGORITHM:
     * 1. Iterate all entities in storage
     * 2. Yield those whose parent matches this folder's ID
     *
     * PERFORMANCE:
     * This is O(n) where n is total entities. For production systems
     * with many entities, an index on parent field is essential.
     *
     * WHY async iterator:
     * Streaming results avoids loading all children into memory.
     * Caller can process/filter lazily.
     *
     * @param ctx - Model context
     * @param id - Parent folder UUID
     * @yields Child entity UUIDs
     */
    async *list(ctx: ModelContext, id: string): AsyncIterable<string> {
        // Scan all entities looking for those with parent = id
        for await (const key of ctx.hal.storage.list(ENTITY_PREFIX)) {
            const data = await ctx.hal.storage.get(key);
            if (!data) continue;

            const entity = decodeEntity<{ parent: string | null; id: string }>(data);
            if (entity.parent === id) {
                yield entity.id;
            }
        }
    }

    // =========================================================================
    // WATCH SUPPORT
    // =========================================================================

    /**
     * Watch for changes to children of a folder.
     *
     * ALGORITHM:
     * 1. Subscribe to all entity changes
     * 2. Filter for those whose parent matches this folder
     * 3. Translate storage events to WatchEvents
     *
     * WHY we watch all entities:
     * We can't know in advance which entities will be children.
     * The storage layer doesn't support compound queries.
     *
     * WHY delete events have empty path:
     * When an entity is deleted, we can't check its parent field
     * (it's gone). We emit the event anyway for consistency.
     *
     * @param ctx - Model context
     * @param id - Folder UUID to watch
     * @param pattern - Optional glob pattern (not implemented)
     * @yields Watch events for child changes
     */
    override async *watch(
        ctx: ModelContext,
        id: string,
        pattern?: string
    ): AsyncIterable<WatchEvent> {
        // Watch all entity changes, filter for children of this folder
        const watchPattern = pattern ?? `${ENTITY_PREFIX}*`;

        for await (const event of ctx.hal.storage.watch(watchPattern)) {
            // Handle deletion specially - can't check parent of deleted entity
            if (event.op === 'delete') {
                yield {
                    entity: event.key.replace(ENTITY_PREFIX, ''),
                    op: 'delete',
                    path: '', // Path unknown for deleted entity
                    timestamp: event.timestamp,
                };
                continue;
            }

            // Skip events without value (shouldn't happen for 'put')
            if (!event.value) continue;

            const entity = decodeEntity<{ parent: string | null; id: string; ctime: number; mtime: number }>(
                event.value
            );

            // Only emit events for direct children of this folder
            if (entity.parent === id) {
                // Determine operation type based on timestamps
                // WHY: ctime === mtime means entity was just created
                const op = entity.ctime === entity.mtime ? 'create' : 'update';

                yield {
                    entity: entity.id,
                    op: event.op === 'put' ? op : 'delete',
                    path: await ctx.computePath(entity.id),
                    timestamp: event.timestamp,
                };
            }
        }
    }
}
