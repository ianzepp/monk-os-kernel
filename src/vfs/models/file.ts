/**
 * FileModel - Standard file storage backed by Entity Model System
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * FileModel extends EntityModel to provide file-specific behavior. Files are
 * entities with model='file' that have content stored in data blobs.
 *
 * This is a thin wrapper that:
 * 1. Hardcodes model='file' in create()
 * 2. Provides file-specific field definitions
 * 3. Inherits all I/O operations from EntityModel
 *
 * @module vfs/models/file
 */

import { EntityModel } from './entity.js';
import type { FieldDef, ModelStat, ModelContext } from '@src/vfs/model.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Schema definition for file entities.
 *
 * Fields:
 * - id: UUID of the file entity
 * - model: Always 'file' for this model
 * - parent: UUID of parent folder
 * - pathname: Filename (not full path)
 * - owner: UUID of creating process/user
 * - data: UUID of the data blob
 * - size: Byte length of content
 * - created_at: Creation timestamp
 * - updated_at: Last modification timestamp
 * - mimetype: Optional MIME type hint
 */
const FILE_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'parent', type: 'string', required: true },
    { name: 'pathname', type: 'string', required: true },
    { name: 'owner', type: 'string', required: true },
    { name: 'data', type: 'string' },
    { name: 'size', type: 'number', required: true },
    { name: 'created_at', type: 'string' },
    { name: 'updated_at', type: 'string' },
    { name: 'mimetype', type: 'string' },
];

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * FileModel - Standard file storage model.
 *
 * Extends EntityModel to provide file-specific behavior.
 * Files are entities with model='file' that store content in data blobs.
 */
export class FileModel extends EntityModel {
    /**
     * Model identifier.
     *
     * Overrides EntityModel's 'entity' name to 'file'.
     */
    override readonly name = 'file';

    /**
     * Return field definitions for file entities.
     */
    override fields(): FieldDef[] {
        return FILE_FIELDS;
    }

    /**
     * Create a new file.
     *
     * Hardcodes model='file' and ensures data blob is created.
     *
     * @param ctx - Model context
     * @param parent - Parent folder UUID
     * @param pathname - Filename
     * @param fields - Optional initial field values
     * @returns Created entity UUID
     */
    override async create(
        ctx: ModelContext,
        parent: string,
        pathname: string,
        fields?: Partial<ModelStat>
    ): Promise<string> {
        // Generate data blob UUID for file content
        const dataId = ctx.hal.entropy.uuid();

        // Create empty data blob
        await ctx.hal.storage.put(`data:${dataId}`, new Uint8Array(0));

        // Delegate to EntityModel with file-specific fields
        return super.create(ctx, parent, pathname, {
            ...fields,
            model: 'file',
            data: dataId,
            size: 0,
        });
    }
}
