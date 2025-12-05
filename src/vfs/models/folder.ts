/**
 * FolderModel - Organizational container backed by Entity Model System
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * FolderModel extends EntityModel to provide folder-specific behavior. Folders
 * are entities with model='folder' that contain other entities (files, folders,
 * devices, etc.) via parent-pointer relationship.
 *
 * This is a thin wrapper that:
 * 1. Hardcodes model='folder' in create()
 * 2. Throws EISDIR on open() (folders can't be opened for I/O)
 * 3. Inherits list/stat/unlink from EntityModel
 *
 * @module vfs/models/folder
 */

import { EntityModel } from './entity.js';
import type { FieldDef, ModelStat, ModelContext } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import { EISDIR } from '@src/hal/index.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Schema definition for folder entities.
 *
 * Note: Folders have no 'data' field (no content blob).
 *
 * Fields:
 * - id: UUID of the folder entity
 * - model: Always 'folder' for this model
 * - parent: UUID of parent folder (null for root)
 * - pathname: Folder name (not full path)
 * - owner: UUID of creating process/user
 * - created_at: Creation timestamp
 * - updated_at: Last modification timestamp
 */
const FOLDER_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'parent', type: 'string' }, // Not required - root has null parent
    { name: 'pathname', type: 'string', required: true },
    { name: 'owner', type: 'string', required: true },
    { name: 'created_at', type: 'string' },
    { name: 'updated_at', type: 'string' },
];

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * FolderModel - Directory container model.
 *
 * Extends EntityModel to provide folder-specific behavior.
 * Folders are entities with model='folder' that contain other entities.
 */
export class FolderModel extends EntityModel {
    /**
     * Model identifier.
     *
     * Overrides EntityModel's 'entity' name to 'folder'.
     */
    override readonly name = 'folder';

    /**
     * Return field definitions for folder entities.
     */
    override fields(): FieldDef[] {
        return FOLDER_FIELDS;
    }

    /**
     * Open a folder for I/O operations.
     *
     * Folders cannot be opened for I/O - use list() instead.
     *
     * @throws EISDIR - Always (folders cannot be opened for I/O)
     */
    override async open(
        _ctx: ModelContext,
        _id: string,
        _flags: OpenFlags,
        _opts?: OpenOptions,
    ): Promise<FileHandle> {
        throw new EISDIR('Cannot open folder for I/O');
    }

    /**
     * Create a new folder.
     *
     * Hardcodes model='folder'.
     *
     * @param ctx - Model context
     * @param parent - Parent folder UUID
     * @param pathname - Folder name
     * @param fields - Optional initial field values
     * @returns Created entity UUID
     */
    override async create(
        ctx: ModelContext,
        parent: string,
        pathname: string,
        fields?: Partial<ModelStat>,
    ): Promise<string> {
        // Delegate to EntityModel with folder-specific fields
        return super.create(ctx, parent, pathname, {
            ...fields,
            model: 'folder',
        });
    }
}
