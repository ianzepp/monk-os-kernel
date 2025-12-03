/**
 * LinkModel - Symbolic link model for path indirection
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * LinkModel implements symbolic links (symlinks) for Monk OS. A symlink stores
 * a target path and, when accessed, the VFS follows that path to reach the
 * actual target entity. This enables path aliasing and cross-filesystem
 * references.
 *
 * IMPORTANT: Symbolic links are currently DISABLED. All create() operations
 * throw EPERM. This is a security precaution until proper symlink resolution
 * is implemented with cycle detection and permission handling.
 *
 * Symlinks differ from hard links:
 * - Symlinks store a path string; hard links share an inode
 * - Symlinks can cross filesystems; hard links cannot
 * - Symlinks can point to non-existent targets; hard links cannot
 *
 * The VFS layer is responsible for symlink resolution during path traversal.
 * This model should NOT be directly opened - the VFS should follow the link
 * and open the target instead.
 *
 * STATE MACHINE
 * =============
 * Symlinks have no runtime state. They exist as metadata records.
 *
 *   create() ──────────> EXISTS ──────────> (deleted)
 *      │                   │                    ^
 *      │ DISABLED          │ unlink()           │
 *      v                   └────────────────────┘
 *   EPERM
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: link.target is always a non-empty string (path)
 * INV-2: link.size is always 0 (symlinks have no content size)
 * INV-3: Opening a symlink directly is an error (VFS should resolve)
 * INV-4: Symlinks have no children
 * INV-5: ctime is set once at creation and never modified
 * INV-6: mtime is updated on target change (setstat)
 *
 * CONCURRENCY MODEL
 * =================
 * Symlink operations are atomic at the storage layer. The target can be
 * changed via setstat, which is a single storage write. No handle state
 * means no concurrent handle issues.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Target validation at resolution time (not creation time)
 * RC-2: Single storage operation for target update
 *
 * SECURITY CONSIDERATIONS
 * =======================
 * Symlinks introduce security risks:
 * - Symlink attacks: pointing to sensitive files
 * - Infinite loops: a -> b -> a
 * - TOCTOU: target changes between check and use
 *
 * These are mitigated by:
 * - Disabling symlink creation (current state)
 * - VFS-level resolution with hop limits (when enabled)
 * - Permission checks on final target
 *
 * MEMORY MANAGEMENT
 * =================
 * - Symlinks have no data blob (target stored in metadata)
 * - No handles to track
 * - Watch support not implemented (no meaningful events)
 *
 * @module vfs/models/link
 */

import { PosixModel } from '@src/vfs/model.js';
import type { ModelStat, ModelContext, FieldDef } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import { ENOENT, EPERM, EINVAL } from '@src/hal/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Storage key prefix for entity metadata.
 * WHY: Consistent with other models; enables namespace partitioning.
 */
const ENTITY_PREFIX = 'entity:';

/**
 * Storage key prefix for access control lists.
 * WHY: ACLs are stored separately to allow efficient permission checks.
 */
const ACCESS_PREFIX = 'access:';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Schema definition for link entities.
 *
 * TESTABILITY: Exported constant allows tests to verify schema structure.
 *
 * Fields:
 * - id: UUID of the link entity
 * - model: Always 'link' for this model
 * - name: Link name (not full path)
 * - parent: UUID of parent folder
 * - owner: UUID of creating process/user
 * - target: Path string the link points to
 * - mtime: Last modification timestamp
 * - ctime: Creation timestamp
 */
const LINK_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'parent', type: 'string', required: true },
    { name: 'owner', type: 'string', required: true },
    { name: 'target', type: 'string', required: true },
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
 * LinkModel - Symbolic link model.
 *
 * Implements path indirection via stored target paths. Currently disabled
 * for security reasons - create() throws EPERM.
 */
export class LinkModel extends PosixModel {
    // =========================================================================
    // MODEL IDENTITY
    // =========================================================================

    /**
     * Model identifier.
     *
     * WHY: Used by VFS to dispatch operations to the correct model.
     * INVARIANT: Always 'link' for this model.
     */
    readonly name = 'link';

    // =========================================================================
    // SCHEMA
    // =========================================================================

    /**
     * Return field definitions for link entities.
     *
     * WHY: Enables schema validation and introspection.
     *
     * @returns Array of field definitions
     */
    fields(): FieldDef[] {
        return LINK_FIELDS;
    }

    // =========================================================================
    // CORE OPERATIONS
    // =========================================================================

    /**
     * Open a symbolic link for I/O operations.
     *
     * WHY this throws:
     * Symlinks should never be opened directly. The VFS layer should
     * resolve the symlink to its target and open that instead. If this
     * method is called, it indicates a bug in the VFS resolution logic.
     *
     * @throws EINVAL - Always (symlinks cannot be opened directly)
     */
    async open(
        _ctx: ModelContext,
        _id: string,
        _flags: OpenFlags,
        _opts?: OpenOptions
    ): Promise<FileHandle> {
        throw new EINVAL('Cannot open symlink directly');
    }

    /**
     * Get metadata for a symbolic link.
     *
     * Returns the link's own metadata, NOT the target's metadata.
     * This is equivalent to lstat() in POSIX - stat() would follow
     * the link and return target metadata.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @returns Link metadata including target path
     * @throws ENOENT - If link does not exist
     */
    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`Link not found: ${id}`);
        }
        return decodeEntity<ModelStat>(data);
    }

    /**
     * Update metadata fields on a symbolic link.
     *
     * ALGORITHM:
     * 1. Load existing entity
     * 2. Merge allowed fields (name, parent, target)
     * 3. Update mtime
     * 4. Write back to storage
     *
     * WHY target can be updated:
     * This allows re-pointing a symlink without delete/recreate.
     * It's the equivalent of POSIX unlink + symlink in one operation.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param fields - Fields to update
     * @throws ENOENT - If link does not exist
     */
    async setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`Link not found: ${id}`);
        }

        const entity = decodeEntity<ModelStat>(data);

        // Update allowed fields
        if (fields.name !== undefined) entity.name = fields.name;
        if (fields.parent !== undefined) entity.parent = fields.parent;
        if (fields.target !== undefined) entity.target = fields.target;

        // Always update mtime on metadata change
        entity.mtime = ctx.hal.clock.now();

        await ctx.hal.storage.put(`${ENTITY_PREFIX}${id}`, encodeEntity(entity));
    }

    /**
     * Create a new symbolic link.
     *
     * CURRENTLY DISABLED: Throws EPERM unconditionally.
     *
     * WHY disabled:
     * Symlink creation introduces security risks that require careful
     * handling in the VFS layer:
     * - Symlink attacks pointing to sensitive files
     * - Infinite resolution loops (a -> b -> a)
     * - TOCTOU vulnerabilities during resolution
     *
     * Before enabling:
     * 1. Implement resolution hop limit in VFS
     * 2. Add permission checks on final target
     * 3. Consider restricting symlink creation by capability
     *
     * @throws EPERM - Always (symlinks are currently disabled)
     */
    async create(
        _ctx: ModelContext,
        _parent: string,
        _name: string,
        _fields?: Partial<ModelStat>
    ): Promise<string> {
        // SECURITY: Symlinks are disabled until proper resolution is implemented
        throw new EPERM('Symbolic links are not supported');
    }

    /**
     * Delete a symbolic link.
     *
     * ALGORITHM:
     * 1. Verify link exists
     * 2. Delete entity metadata
     * 3. Delete ACL (if exists)
     *
     * WHY we delete ACL:
     * Links can have their own ACLs separate from their target.
     * Deleting the link should clean up its ACL.
     *
     * @param ctx - Model context
     * @param id - Entity UUID to delete
     * @throws ENOENT - If link does not exist
     */
    async unlink(ctx: ModelContext, id: string): Promise<void> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`Link not found: ${id}`);
        }

        // Delete entity metadata
        await ctx.hal.storage.delete(`${ENTITY_PREFIX}${id}`);

        // Delete ACL (cleanup, may not exist)
        await ctx.hal.storage.delete(`${ACCESS_PREFIX}${id}`);
    }

    /**
     * List children of a symbolic link.
     *
     * WHY this returns nothing:
     * Symlinks are leaf nodes. They have no children - they point to
     * targets which may have children, but that's not the same thing.
     *
     * @returns Empty iterator
     */
    async *list(_ctx: ModelContext, _id: string): AsyncIterable<string> {
        // Links don't have children - this is a no-op
        return;
    }

    // =========================================================================
    // SYMLINK-SPECIFIC OPERATIONS
    // =========================================================================

    /**
     * Read the symlink target without following it.
     *
     * ALGORITHM:
     * 1. Load entity metadata
     * 2. Return target path string
     *
     * WHY this exists:
     * This is equivalent to POSIX readlink(). It allows inspection of
     * where a symlink points without actually traversing to the target.
     * Used by tools like 'ls -l' to display link targets.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @returns Target path string
     * @throws ENOENT - If link does not exist
     */
    async readlink(ctx: ModelContext, id: string): Promise<string> {
        const stat = await this.stat(ctx, id);
        return stat.target as string;
    }
}
