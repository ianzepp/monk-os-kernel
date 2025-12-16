/**
 * EntityMount - Synthetic filesystem backed by EMS entity data
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * EntityMount provides a virtual filesystem that exposes entity data from the
 * Entity Management System (EMS) as files. Entities become directories with
 * subdirectories for fields, parent navigation, and relationship traversal.
 *
 * This follows the Plan 9 philosophy where "everything is a file", allowing
 * tools like cat, grep, and standard shell pipelines to work with entity data.
 *
 * PATH STRUCTURE
 * ==============
 * /mount/{model}/{key}/
 *   fields/
 *     {field-name}           → field value as file content
 *   parent                   → symlink to parent entity
 *   relationships/
 *     {relationship-name}/
 *       {related-key}/       → related entity (recursive structure)
 *         fields/
 *         parent
 *         relationships/     → up to maxDepth
 *
 * EXAMPLES
 * ========
 * /data/users/alice/fields/email           → "alice@example.com"
 * /data/users/alice/relationships/posts/   → lists post entities
 * /data/users/alice/relationships/posts/123/fields/title → "My Post"
 *
 * MOUNT OPTIONS
 * =============
 * - model: Filter to a single model type (e.g., "users")
 * - field: Use this field's value as directory name (default: "id")
 *          Must have indexed='unique' in the fields table
 * - maxDepth: Maximum relationship traversal depth (default: 3)
 *
 * READ-ONLY
 * =========
 * Currently read-only. Future versions may support writes that flow through
 * to the database via EntityOps.
 *
 * @module vfs/mounts/entity
 */

import type { FileHandle, OpenFlags, SeekWhence } from '@src/vfs/handle.js';
import type { ModelStat } from '@src/vfs/model.js';
import type { PathCache } from '@src/vfs/path-cache.js';
import type { EntityOps, EntityRecord } from '@src/ems/entity-ops.js';
import type { ModelCache } from '@src/ems/model-cache.js';
import { ENOENT, EACCES, EISDIR, ENOTDIR, EBADF, EROFS, EINVAL } from '@src/hal/errors.js';
import { KERNEL_ID } from '@src/kernel/types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const ENTITY_ID_PREFIX = 'entity:';
const ENTITY_HANDLE_PREFIX = 'entity-handle:';
const ENTITY_FILE_OWNER = KERNEL_ID;

/** Default maximum depth for relationship traversal */
const DEFAULT_MAX_DEPTH = 3;

// =============================================================================
// TYPES
// =============================================================================

/**
 * EntityMount configuration.
 */
export interface EntityMount {
    /** VFS path where mount is attached */
    vfsPath: string;

    /** Path cache for path/id resolution */
    cache: PathCache;

    /** Entity operations for database queries */
    db: EntityOps;

    /** Model cache for field metadata */
    modelCache: ModelCache;

    /** Optional: filter to single model */
    model?: string;

    /** Field to use as directory name (default: 'id') */
    field: string;

    /** Maximum relationship traversal depth */
    maxDepth: number;
}

/**
 * Options for creating an entity mount.
 */
export interface EntityMountOptions {
    /** Filter to single model type */
    model?: string;

    /** Field to use as directory name (default: 'id', must be unique) */
    field?: string;

    /** Maximum relationship traversal depth (default: 3) */
    maxDepth?: number;
}

/**
 * Parsed path types within the entity mount.
 */
type ParsedPathType =
    | 'root'              // /mount
    | 'model'             // /mount/{model}
    | 'entity'            // /mount/{model}/{key}
    | 'fields_dir'        // /mount/{model}/{key}/fields
    | 'field'             // /mount/{model}/{key}/fields/{field}
    | 'parent'            // /mount/{model}/{key}/parent
    | 'relationships_dir' // /mount/{model}/{key}/relationships
    | 'relationship'      // /mount/{model}/{key}/relationships/{rel-name}
    | 'related_entity';   // /mount/{model}/{key}/relationships/{rel-name}/{key} (recursive)

/**
 * Context for an entity within the path.
 */
interface EntityContext {
    model: string;
    entityKey: string;
    entityId: string;
}

/**
 * Parsed entity mount path.
 */
interface ParsedEntityPath {
    type: ParsedPathType;
    /** Entity context chain (for nested relationship traversal) */
    entities: EntityContext[];
    /** Current depth in relationship traversal */
    depth: number;
    /** Field name (for 'field' type) */
    fieldName?: string;
    /** Relationship name (for 'relationship' or 'related_entity' type) */
    relationshipName?: string;
    /** Related model (for relationship types) */
    relatedModel?: string;
}

// =============================================================================
// MOUNT CONFIGURATION
// =============================================================================

/**
 * Create an entity mount configuration.
 *
 * @param vfsPath - VFS path to mount at
 * @param cache - Entity cache for lookups
 * @param db - Entity operations for queries
 * @param modelCache - Model cache for field metadata
 * @param options - Mount options
 * @returns EntityMount configuration
 * @throws EINVAL if field is specified but not unique
 */
export async function createEntityMount(
    vfsPath: string,
    cache: PathCache,
    db: EntityOps,
    modelCache: ModelCache,
    options: EntityMountOptions = {},
): Promise<EntityMount> {
    const normalizedPath = vfsPath.replace(/\/+$/, '') || '/entity';
    const field = options.field ?? 'id';
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

    // Validate field uniqueness if not 'id'
    if (field !== 'id' && options.model) {
        const model = await modelCache.get(options.model);

        if (!model) {
            throw new EINVAL(`Model not found: ${options.model}`);
        }

        const fieldDef = model.getField(field);

        if (!fieldDef) {
            throw new EINVAL(`Field '${field}' not found on model '${options.model}'`);
        }

        if (fieldDef.indexed !== 'unique') {
            throw new EINVAL(`Field '${field}' must be unique to use as entity key`);
        }
    }

    return {
        vfsPath: normalizedPath,
        cache,
        db,
        modelCache,
        model: options.model,
        field,
        maxDepth,
    };
}

// =============================================================================
// PATH RESOLUTION
// =============================================================================

/**
 * Check if a path is under this entity mount.
 */
export function isUnderEntityMount(mount: EntityMount, vfsPath: string): boolean {
    if (vfsPath === mount.vfsPath) {
        return true;
    }

    return vfsPath.startsWith(mount.vfsPath + '/');
}

/**
 * Resolve an entity key to its UUID.
 *
 * If field is 'id', the key IS the UUID.
 * Otherwise, query the database to find the entity with that field value.
 */
async function resolveEntityId(
    mount: EntityMount,
    model: string,
    key: string,
): Promise<string | null> {
    if (mount.field === 'id') {
        // Key is the UUID - verify it exists
        const entity = mount.cache.getEntry(key);

        if (!entity || entity.model !== model) {
            return null;
        }

        return key;
    }

    // Query by field value
    for await (const record of mount.db.selectAny<EntityRecord>(model, {
        where: { [mount.field]: key },
    })) {
        return record.id;
    }

    return null;
}

/**
 * Resolve a related entity by key within a relationship.
 */
async function resolveRelatedEntityId(
    mount: EntityMount,
    model: string,
    key: string,
): Promise<string | null> {
    // For relationships, always use 'id' as the key (or the mount's field if same model)
    const entity = mount.cache.getEntry(key);

    if (entity && entity.model === model) {
        return key;
    }

    // Try querying by mount's field if applicable
    if (mount.field !== 'id') {
        for await (const record of mount.db.selectAny<EntityRecord>(model, {
            where: { [mount.field]: key },
        })) {
            return record.id;
        }
    }

    return null;
}

/**
 * Get relationships for a model (fields with relationship_type set).
 */
async function getModelRelationships(
    mount: EntityMount,
    modelName: string,
): Promise<Map<string, { relatedModel: string; fieldName: string }>> {
    const model = await mount.modelCache.get(modelName);

    if (!model) {
        return new Map();
    }

    const relationships = new Map<string, { relatedModel: string; fieldName: string }>();

    for (const field of model.getFields()) {
        if (field.relationship_type && field.related_model) {
            const name = field.relationship_name || field.field_name;

            relationships.set(name, {
                relatedModel: field.related_model,
                fieldName: field.field_name,
            });
        }
    }

    return relationships;
}

/**
 * Parse an entity mount path into components.
 *
 * Handles recursive relationship traversal up to maxDepth.
 */
async function parseEntityPath(
    mount: EntityMount,
    vfsPath: string,
): Promise<ParsedEntityPath | null> {
    if (vfsPath === mount.vfsPath) {
        return { type: 'root', entities: [], depth: 0 };
    }

    const prefix = mount.vfsPath + '/';

    if (!vfsPath.startsWith(prefix)) {
        return null;
    }

    const relativePath = vfsPath.slice(prefix.length);
    const parts = relativePath.split('/').filter(Boolean);

    if (parts.length === 0) {
        return { type: 'root', entities: [], depth: 0 };
    }

    // Determine starting model
    let currentModel: string;
    let partIndex = 0;

    if (mount.model) {
        // Model is fixed by mount options
        currentModel = mount.model;
    }
    else {
        // First part is model name
        currentModel = parts[0]!;
        partIndex = 1;

        if (parts.length === 1) {
            // Just the model name
            const model = await mount.modelCache.get(currentModel);

            if (!model) {
                return null;
            }

            return { type: 'model', entities: [], depth: 0 };
        }
    }

    // Now parse entity and its contents
    return parseEntityContents(mount, parts, partIndex, currentModel, [], 0);
}

/**
 * Recursively parse entity contents (fields, parent, relationships).
 */
async function parseEntityContents(
    mount: EntityMount,
    parts: string[],
    partIndex: number,
    currentModel: string,
    entities: EntityContext[],
    depth: number,
): Promise<ParsedEntityPath | null> {
    // Check depth limit
    if (depth > mount.maxDepth) {
        return null;
    }

    // Need at least an entity key
    if (partIndex >= parts.length) {
        return null;
    }

    const entityKey = parts[partIndex]!;
    const entityId = depth === 0
        ? await resolveEntityId(mount, currentModel, entityKey)
        : await resolveRelatedEntityId(mount, currentModel, entityKey);

    if (!entityId) {
        return null;
    }

    const entityContext: EntityContext = {
        model: currentModel,
        entityKey,
        entityId,
    };
    const newEntities = [...entities, entityContext];

    // Just the entity key - return entity directory
    if (partIndex + 1 >= parts.length) {
        return { type: 'entity', entities: newEntities, depth };
    }

    const nextPart = parts[partIndex + 1]!;

    // Check for reserved directories
    if (nextPart === 'fields') {
        if (partIndex + 2 >= parts.length) {
            return { type: 'fields_dir', entities: newEntities, depth };
        }

        if (partIndex + 2 === parts.length - 1) {
            return {
                type: 'field',
                entities: newEntities,
                depth,
                fieldName: parts[partIndex + 2],
            };
        }

        return null; // Too many parts after field name
    }

    if (nextPart === 'parent') {
        if (partIndex + 2 >= parts.length) {
            return { type: 'parent', entities: newEntities, depth };
        }

        return null; // parent is a symlink, can't traverse into it here
    }

    if (nextPart === 'relationships') {
        if (partIndex + 2 >= parts.length) {
            return { type: 'relationships_dir', entities: newEntities, depth };
        }

        const relationshipName = parts[partIndex + 2]!;

        // Look up the relationship
        const relationships = await getModelRelationships(mount, currentModel);
        const rel = relationships.get(relationshipName);

        if (!rel) {
            return null; // Unknown relationship
        }

        if (partIndex + 3 >= parts.length) {
            return {
                type: 'relationship',
                entities: newEntities,
                depth,
                relationshipName,
                relatedModel: rel.relatedModel,
            };
        }

        // Recurse into the related entity
        return parseEntityContents(
            mount,
            parts,
            partIndex + 3,
            rel.relatedModel,
            newEntities,
            depth + 1,
        );
    }

    return null; // Unknown directory at entity level
}

// =============================================================================
// FILE OPERATIONS
// =============================================================================

/**
 * Get stat for an entity mount path.
 */
export async function entityStat(
    mount: EntityMount,
    vfsPath: string,
): Promise<ModelStat> {
    const parsed = await parseEntityPath(mount, vfsPath);

    if (!parsed) {
        throw new ENOENT(`No such file: ${vfsPath}`);
    }

    const now = Date.now();
    const lastEntity = parsed.entities[parsed.entities.length - 1];

    switch (parsed.type) {
        case 'root':
            return {
                id: `${ENTITY_ID_PREFIX}root`,
                model: 'folder',
                name: mount.vfsPath.split('/').pop() || 'entity',
                parent: null,
                owner: ENTITY_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
            };

        case 'model':
            return {
                id: `${ENTITY_ID_PREFIX}model:${mount.model || vfsPath.split('/').pop()}`,
                model: 'folder',
                name: mount.model || vfsPath.split('/').pop() || 'unknown',
                parent: null,
                owner: ENTITY_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
            };

        case 'entity':
            return {
                id: `${ENTITY_ID_PREFIX}${lastEntity!.entityId}`,
                model: 'folder',
                name: lastEntity!.entityKey,
                parent: null,
                owner: ENTITY_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
            };

        case 'fields_dir':
            return {
                id: `${ENTITY_ID_PREFIX}${lastEntity!.entityId}/fields`,
                model: 'folder',
                name: 'fields',
                parent: null,
                owner: ENTITY_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
            };

        case 'field': {
            const record = await getEntityRecord(mount, lastEntity!.model, lastEntity!.entityId);

            if (!record) {
                throw new ENOENT(`Entity not found: ${lastEntity!.entityId}`);
            }

            const value = formatFieldValue(record[parsed.fieldName!]);

            return {
                id: `${ENTITY_ID_PREFIX}${lastEntity!.entityId}/fields/${parsed.fieldName}`,
                model: 'file',
                name: parsed.fieldName!,
                parent: null,
                owner: ENTITY_FILE_OWNER,
                size: new TextEncoder().encode(value).length,
                mtime: now,
                ctime: now,
            };
        }

        case 'parent': {
            const record = await getEntityRecord(mount, lastEntity!.model, lastEntity!.entityId);

            if (!record) {
                throw new ENOENT(`Entity not found: ${lastEntity!.entityId}`);
            }

            const parentId = record.parent as string | undefined;

            return {
                id: `${ENTITY_ID_PREFIX}${lastEntity!.entityId}/parent`,
                model: 'link',
                name: 'parent',
                parent: null,
                owner: ENTITY_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
                target: parentId ? `../../${parentId}` : undefined,
            };
        }

        case 'relationships_dir':
            return {
                id: `${ENTITY_ID_PREFIX}${lastEntity!.entityId}/relationships`,
                model: 'folder',
                name: 'relationships',
                parent: null,
                owner: ENTITY_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
            };

        case 'relationship':
            return {
                id: `${ENTITY_ID_PREFIX}${lastEntity!.entityId}/relationships/${parsed.relationshipName}`,
                model: 'folder',
                name: parsed.relationshipName!,
                parent: null,
                owner: ENTITY_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
            };

        case 'related_entity':
            // This shouldn't happen - related entities become 'entity' type
            throw new ENOENT(`No such file: ${vfsPath}`);
    }
}

/**
 * List contents of an entity mount directory.
 */
export async function* entityReaddir(
    mount: EntityMount,
    vfsPath: string,
): AsyncIterable<ModelStat> {
    const parsed = await parseEntityPath(mount, vfsPath);

    if (!parsed) {
        throw new ENOENT(`No such directory: ${vfsPath}`);
    }

    const now = Date.now();
    const lastEntity = parsed.entities[parsed.entities.length - 1];

    switch (parsed.type) {
        case 'root':
            if (mount.model) {
                // List entities in the filtered model
                yield* listEntities(mount, mount.model, now);
            }
            else {
                // List all models
                yield* listModels(mount, now);
            }

            break;

        case 'model': {
            const modelName = mount.model || vfsPath.split('/').pop()!;

            yield* listEntities(mount, modelName, now);
            break;
        }

        case 'entity':
            // List: fields/, parent, relationships/
            yield* listEntityContents(mount, lastEntity!, now);
            break;

        case 'fields_dir':
            // List field names as files
            yield* listFields(mount, lastEntity!, now);
            break;

        case 'relationships_dir':
            // List relationship names
            yield* listRelationships(mount, lastEntity!, now);
            break;

        case 'relationship':
            // List related entities
            yield* listRelatedEntities(mount, lastEntity!, parsed.relationshipName!, parsed.relatedModel!, now);
            break;

        case 'field':
        case 'parent':
            throw new ENOTDIR(`Not a directory: ${vfsPath}`);

        case 'related_entity':
            throw new ENOENT(`No such directory: ${vfsPath}`);
    }
}

/**
 * Open an entity field for reading.
 */
export async function entityOpen(
    mount: EntityMount,
    vfsPath: string,
    flags: OpenFlags,
): Promise<FileHandle> {
    if (flags.write) {
        throw new EROFS(`Entity mount is read-only: ${vfsPath}`);
    }

    const parsed = await parseEntityPath(mount, vfsPath);

    if (!parsed) {
        throw new ENOENT(`No such file: ${vfsPath}`);
    }

    if (parsed.type !== 'field') {
        throw new EISDIR(`Is a directory: ${vfsPath}`);
    }

    const lastEntity = parsed.entities[parsed.entities.length - 1]!;
    const record = await getEntityRecord(mount, lastEntity.model, lastEntity.entityId);

    if (!record) {
        throw new ENOENT(`Entity not found: ${lastEntity.entityId}`);
    }

    const value = formatFieldValue(record[parsed.fieldName!]);

    return new EntityFieldHandle(vfsPath, parsed.fieldName!, value, flags);
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Get an entity record from the database.
 */
async function getEntityRecord(
    mount: EntityMount,
    model: string,
    id: string,
): Promise<EntityRecord | null> {
    for await (const record of mount.db.selectAny<EntityRecord>(model, {
        where: { id },
    })) {
        return record;
    }

    return null;
}

/**
 * Format a field value for file content.
 */
function formatFieldValue(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }

    if (typeof value === 'object') {
        return JSON.stringify(value, null, 2) + '\n';
    }

    return String(value) + '\n';
}

/**
 * List all models as directories.
 */
async function* listModels(
    mount: EntityMount,
    now: number,
): AsyncIterable<ModelStat> {
    const modelNames = mount.modelCache.getCachedModelNames();

    for (const modelName of modelNames) {
        yield {
            id: `${ENTITY_ID_PREFIX}model:${modelName}`,
            model: 'folder',
            name: modelName,
            parent: null,
            owner: ENTITY_FILE_OWNER,
            size: 0,
            mtime: now,
            ctime: now,
        };
    }
}

/**
 * List entities in a model as directories.
 */
async function* listEntities(
    mount: EntityMount,
    modelName: string,
    now: number,
): AsyncIterable<ModelStat> {
    for await (const record of mount.db.selectAny<EntityRecord>(modelName, {})) {
        let displayName = record.id;

        if (mount.field !== 'id' && record[mount.field] !== undefined) {
            displayName = String(record[mount.field]);
        }

        yield {
            id: `${ENTITY_ID_PREFIX}${record.id}`,
            model: 'folder',
            name: displayName,
            parent: null,
            owner: ENTITY_FILE_OWNER,
            size: 0,
            mtime: now,
            ctime: now,
        };
    }
}

/**
 * List entity contents: fields/, parent, relationships/
 */
async function* listEntityContents(
    mount: EntityMount,
    entity: EntityContext,
    now: number,
): AsyncIterable<ModelStat> {
    // fields/ directory
    yield {
        id: `${ENTITY_ID_PREFIX}${entity.entityId}/fields`,
        model: 'folder',
        name: 'fields',
        parent: null,
        owner: ENTITY_FILE_OWNER,
        size: 0,
        mtime: now,
        ctime: now,
    };

    // parent symlink
    const record = await getEntityRecord(mount, entity.model, entity.entityId);
    const parentId = record?.parent as string | undefined;

    yield {
        id: `${ENTITY_ID_PREFIX}${entity.entityId}/parent`,
        model: 'link',
        name: 'parent',
        parent: null,
        owner: ENTITY_FILE_OWNER,
        size: 0,
        mtime: now,
        ctime: now,
        target: parentId ? `../${parentId}` : undefined,
    };

    // relationships/ directory
    yield {
        id: `${ENTITY_ID_PREFIX}${entity.entityId}/relationships`,
        model: 'folder',
        name: 'relationships',
        parent: null,
        owner: ENTITY_FILE_OWNER,
        size: 0,
        mtime: now,
        ctime: now,
    };
}

/**
 * List fields of an entity as files.
 */
async function* listFields(
    mount: EntityMount,
    entity: EntityContext,
    now: number,
): AsyncIterable<ModelStat> {
    const record = await getEntityRecord(mount, entity.model, entity.entityId);

    if (!record) {
        return;
    }

    for (const [fieldName, value] of Object.entries(record)) {
        const content = formatFieldValue(value);

        yield {
            id: `${ENTITY_ID_PREFIX}${entity.entityId}/fields/${fieldName}`,
            model: 'file',
            name: fieldName,
            parent: null,
            owner: ENTITY_FILE_OWNER,
            size: new TextEncoder().encode(content).length,
            mtime: now,
            ctime: now,
        };
    }
}

/**
 * List relationships of an entity.
 */
async function* listRelationships(
    mount: EntityMount,
    entity: EntityContext,
    now: number,
): AsyncIterable<ModelStat> {
    const relationships = await getModelRelationships(mount, entity.model);

    for (const [relName] of relationships) {
        yield {
            id: `${ENTITY_ID_PREFIX}${entity.entityId}/relationships/${relName}`,
            model: 'folder',
            name: relName,
            parent: null,
            owner: ENTITY_FILE_OWNER,
            size: 0,
            mtime: now,
            ctime: now,
        };
    }
}

/**
 * List related entities within a relationship.
 */
async function* listRelatedEntities(
    mount: EntityMount,
    entity: EntityContext,
    relationshipName: string,
    relatedModel: string,
    now: number,
): AsyncIterable<ModelStat> {
    // Get the relationship field info
    const relationships = await getModelRelationships(mount, entity.model);
    const rel = relationships.get(relationshipName);

    if (!rel) {
        return;
    }

    // Get the entity's record to find related IDs
    const record = await getEntityRecord(mount, entity.model, entity.entityId);

    if (!record) {
        return;
    }

    // The field value might be a single ID or array of IDs
    const relatedValue = record[rel.fieldName];

    if (!relatedValue) {
        return;
    }

    const relatedIds = Array.isArray(relatedValue) ? relatedValue : [relatedValue];

    for (const relatedId of relatedIds) {
        if (typeof relatedId !== 'string') {
            continue;
        }

        // Get display name for the related entity
        let displayName = relatedId;

        if (mount.field !== 'id') {
            const relatedRecord = await getEntityRecord(mount, relatedModel, relatedId);

            if (relatedRecord && relatedRecord[mount.field] !== undefined) {
                displayName = String(relatedRecord[mount.field]);
            }
        }

        yield {
            id: `${ENTITY_ID_PREFIX}${relatedId}`,
            model: 'folder',
            name: displayName,
            parent: null,
            owner: ENTITY_FILE_OWNER,
            size: 0,
            mtime: now,
            ctime: now,
        };
    }
}

// =============================================================================
// FILE HANDLE IMPLEMENTATION
// =============================================================================

/**
 * Handle for reading entity field values.
 */
class EntityFieldHandle implements FileHandle {
    readonly id: string;
    readonly path: string;
    readonly flags: OpenFlags;

    private _closed = false;
    private _position = 0;
    private readonly _content: Uint8Array;

    constructor(
        vfsPath: string,
        _fieldName: string,
        value: string,
        flags: OpenFlags,
    ) {
        this.id = `${ENTITY_HANDLE_PREFIX}${vfsPath}:${Date.now()}`;
        this.path = vfsPath;
        this.flags = flags;
        this._content = new TextEncoder().encode(value);
    }

    get closed(): boolean {
        return this._closed;
    }

    async read(size?: number): Promise<Uint8Array> {
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        if (!this.flags.read) {
            throw new EACCES('Not opened for reading');
        }

        const remaining = this._content.length - this._position;

        if (remaining <= 0) {
            return new Uint8Array(0);
        }

        const toRead = size !== undefined ? Math.min(size, remaining) : remaining;
        const result = this._content.slice(this._position, this._position + toRead);

        this._position += toRead;

        return result;
    }

    async write(_data: Uint8Array): Promise<number> {
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        throw new EROFS('Entity mount is read-only');
    }

    async seek(offset: number, whence: SeekWhence): Promise<number> {
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        let newPosition: number;

        switch (whence) {
            case 'start': newPosition = offset; break;
            case 'current': newPosition = this._position + offset; break;
            case 'end': newPosition = this._content.length + offset; break;
        }

        if (newPosition < 0) {
            newPosition = 0;
        }

        this._position = newPosition;

        return this._position;
    }

    async tell(): Promise<number> {
        return this._position;
    }

    async sync(): Promise<void> {}

    async close(): Promise<void> {
        this._closed = true;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}
