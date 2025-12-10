/**
 * EMS Syscalls - Entity Management System operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * EMS syscalls provide the interface between user processes and the Entity
 * Management System. Each syscall is a standalone async generator function
 * that receives explicit dependencies (proc, ems) and yields Response messages.
 *
 * Operations:
 * - ems:describe - Introspect model schemas
 * - ems:select   - Query entities (streaming)
 * - ems:create   - Create new entities
 * - ems:update   - Update existing entities
 * - ems:delete   - Soft delete entities
 * - ems:expire   - Hard delete entities
 * - ems:revert   - Restore soft-deleted entities
 * - ems:import   - Import model + field definitions (convenience)
 *
 * All operations go through the EntityOps observer pipeline, ensuring
 * validation, triggers, and audit logging are applied consistently.
 *
 * DESIGN: EMS syscalls need proc and EMS
 * ======================================
 * The proc is currently unused but reserved for future ACL checks.
 * The EMS instance provides access to EntityOps for database operations.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All model arguments must be validated as strings
 * INV-2: Every syscall must yield at least one Response (ok, error, item, done)
 * INV-3: Stream responses (select) terminate with 'done'
 * INV-4: Single-record responses (create, update) use 'ok'
 *
 * @module syscall/ems
 */

import type { EMS } from '@src/ems/ems.js';
import type { EntityRecord } from '@src/ems/entity-ops.js';
import type { Process, Response } from './types.js';
import { respond } from './types.js';

// =============================================================================
// SCHEMA INTROSPECTION
// =============================================================================

/**
 * Describe model schemas.
 *
 * Streams model definitions with their fields. If model is specified,
 * returns only that model. Otherwise returns all active models.
 *
 * Response format per model:
 * {
 *   model_name: string,
 *   status: string,
 *   description: string | null,
 *   fields: Array<{
 *     field_name: string,
 *     type: string,
 *     required: boolean,
 *     unique: boolean,
 *     description: string | null,
 *     related_model: string | null,
 *     enum_values: string[] | null
 *   }>
 * }
 *
 * @param proc - Calling process (reserved for future ACL)
 * @param ems - EMS instance
 * @param model - Optional model name to describe (null = all models)
 */
export async function* emsDescribe(
    _proc: Process,
    ems: EMS,
    model?: unknown,
): AsyncIterable<Response> {
    // Validate model arg if provided
    if (model !== undefined && model !== null && typeof model !== 'string') {
        yield respond.error('EINVAL', 'model must be a string or null');

        return;
    }

    try {
        // Build filter for models query
        const modelFilter: Record<string, unknown> = {};

        if (typeof model === 'string') {
            modelFilter.where = { model_name: model };
        }

        // Collect models first (need to query fields for each)
        const models: Array<{
            model_name: string;
            status: string;
            description: string | null;
        }> = [];

        for await (const row of ems.ops.selectAny('models', modelFilter)) {
            const rec = row as Record<string, unknown>;

            models.push({
                model_name: rec.model_name as string,
                status: rec.status as string,
                description: rec.description as string | null,
            });
        }

        // If specific model requested but not found
        if (typeof model === 'string' && models.length === 0) {
            yield respond.error('ENOENT', `Model not found: ${model}`);

            return;
        }

        // For each model, get fields and yield
        for (const m of models) {
            const fields: Array<{
                field_name: string;
                type: string;
                required: boolean;
                unique: boolean;
                description: string | null;
                related_model: string | null;
                enum_values: string[] | null;
            }> = [];

            for await (const fieldRow of ems.ops.selectAny('fields', {
                where: { model_name: m.model_name },
            })) {
                const f = fieldRow as Record<string, unknown>;

                // Parse enum_values if present (stored as JSON string)
                let enumValues: string[] | null = null;

                if (typeof f.enum_values === 'string') {
                    try {
                        enumValues = JSON.parse(f.enum_values);
                    }
                    catch {
                        // Malformed JSON, leave as null
                    }
                }

                fields.push({
                    field_name: f.field_name as string,
                    type: f.type as string,
                    required: Boolean(f.required),
                    unique: f.indexed === 'unique',
                    description: f.description as string | null,
                    related_model: f.related_model as string | null,
                    enum_values: enumValues,
                });
            }

            yield respond.item({
                model_name: m.model_name,
                status: m.status,
                description: m.description,
                fields,
            });
        }

        yield respond.done();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

// =============================================================================
// QUERY OPERATIONS
// =============================================================================

/**
 * Select entities matching a filter.
 *
 * Streams matching records as 'item' responses, followed by 'done'.
 *
 * @param proc - Calling process (reserved for future ACL)
 * @param ems - EMS instance
 * @param model - Model name to query
 * @param filter - Filter criteria (where, order, limit, offset)
 */
export async function* emsSelect(
    _proc: Process,
    ems: EMS,
    model: unknown,
    filter?: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string') {
        yield respond.error('EINVAL', 'model must be a string');

        return;
    }

    const filterData = (typeof filter === 'object' && filter !== null)
        ? filter as Record<string, unknown>
        : {};

    try {
        for await (const record of ems.ops.selectAny(model, filterData)) {
            yield respond.item(record);
        }

        yield respond.done();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

// =============================================================================
// MUTATION OPERATIONS
// =============================================================================

/**
 * Create a new entity.
 *
 * @param proc - Calling process
 * @param ems - EMS instance
 * @param model - Model name
 * @param fields - Entity fields
 */
export async function* emsCreate(
    _proc: Process,
    ems: EMS,
    model: unknown,
    fields: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string') {
        yield respond.error('EINVAL', 'model must be a string');

        return;
    }

    if (typeof fields !== 'object' || fields === null) {
        yield respond.error('EINVAL', 'fields must be an object');

        return;
    }

    try {
        for await (const created of ems.ops.createAll(model, [fields as Record<string, unknown>])) {
            yield respond.ok(created);

            return;
        }

        yield respond.error('EIO', 'No record created');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

/**
 * Update an entity by ID.
 *
 * @param proc - Calling process
 * @param ems - EMS instance
 * @param model - Model name
 * @param id - Entity ID
 * @param changes - Fields to update
 */
export async function* emsUpdate(
    _proc: Process,
    ems: EMS,
    model: unknown,
    id: unknown,
    changes: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string') {
        yield respond.error('EINVAL', 'model must be a string');

        return;
    }

    if (typeof id !== 'string') {
        yield respond.error('EINVAL', 'id must be a string');

        return;
    }

    if (typeof changes !== 'object' || changes === null) {
        yield respond.error('EINVAL', 'changes must be an object');

        return;
    }

    try {
        const updates = [{ id, changes: changes as Partial<EntityRecord> }];

        for await (const updated of ems.ops.updateAll(model, updates)) {
            yield respond.ok(updated);

            return;
        }

        yield respond.error('ENOENT', `Entity not found: ${id}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

/**
 * Delete (soft) an entity by ID.
 *
 * @param proc - Calling process
 * @param ems - EMS instance
 * @param model - Model name
 * @param id - Entity ID
 */
export async function* emsDelete(
    _proc: Process,
    ems: EMS,
    model: unknown,
    id: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string') {
        yield respond.error('EINVAL', 'model must be a string');

        return;
    }

    if (typeof id !== 'string') {
        yield respond.error('EINVAL', 'id must be a string');

        return;
    }

    try {
        for await (const deleted of ems.ops.deleteIds(model, [id])) {
            yield respond.ok(deleted);

            return;
        }

        yield respond.error('ENOENT', `Entity not found: ${id}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

/**
 * Revert (undelete) a soft-deleted entity.
 *
 * @param proc - Calling process
 * @param ems - EMS instance
 * @param model - Model name
 * @param id - Entity ID
 */
export async function* emsRevert(
    _proc: Process,
    ems: EMS,
    model: unknown,
    id: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string') {
        yield respond.error('EINVAL', 'model must be a string');

        return;
    }

    if (typeof id !== 'string') {
        yield respond.error('EINVAL', 'id must be a string');

        return;
    }

    try {
        for await (const reverted of ems.ops.revertAll(model, [{ id }])) {
            yield respond.ok(reverted);

            return;
        }

        yield respond.error('ENOENT', `Entity not found: ${id}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

/**
 * Expire (hard delete) an entity permanently.
 *
 * @param proc - Calling process
 * @param ems - EMS instance
 * @param model - Model name
 * @param id - Entity ID
 */
export async function* emsExpire(
    _proc: Process,
    ems: EMS,
    model: unknown,
    id: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string') {
        yield respond.error('EINVAL', 'model must be a string');

        return;
    }

    if (typeof id !== 'string') {
        yield respond.error('EINVAL', 'id must be a string');

        return;
    }

    try {
        for await (const expired of ems.ops.expireAll(model, [{ id }])) {
            yield respond.ok(expired);

            return;
        }

        yield respond.error('ENOENT', `Entity not found: ${id}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

// =============================================================================
// SCHEMA IMPORT
// =============================================================================

/**
 * Known model-level properties that can be set via import.
 * Everything else is assumed to be in the 'fields' object.
 */
const MODEL_PROPS = new Set([
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
 * This is a convenience syscall for external apps and packages to register
 * their EMS models without making N+1 individual create calls (1 model + N fields).
 *
 * The operation is strictly additive:
 * - Model is upserted (created or updated)
 * - Fields are upserted (created or updated)
 * - Existing fields not in the definition are NOT removed
 *
 * Ring 6 DDL observers handle the actual table/column creation.
 *
 * @example
 * ```typescript
 * { op: 'ems:import', args: ['window', {
 *     description: 'Application window',
 *     passthrough: false,
 *     fields: {
 *         title: { type: 'text', required: true },
 *         x: { type: 'integer', default_value: '0' },
 *         y: { type: 'integer', default_value: '0' }
 *     }
 * }]}
 * ```
 *
 * @param proc - Calling process (reserved for future ACL)
 * @param ems - EMS instance
 * @param model - Model name to import
 * @param definition - Model definition with optional flags and fields object
 */
export async function* emsImport(
    _proc: Process,
    ems: EMS,
    model: unknown,
    definition: unknown,
): AsyncIterable<Response> {
    // -------------------------------------------------------------------------
    // Validate arguments
    // -------------------------------------------------------------------------

    if (typeof model !== 'string') {
        yield respond.error('EINVAL', 'model must be a string');

        return;
    }

    if (typeof definition !== 'object' || definition === null) {
        yield respond.error('EINVAL', 'definition must be an object');

        return;
    }

    const def = definition as Record<string, unknown>;
    const fields = def.fields;

    if (typeof fields !== 'object' || fields === null) {
        yield respond.error('EINVAL', 'definition.fields must be an object');

        return;
    }

    const fieldsObj = fields as Record<string, unknown>;

    // -------------------------------------------------------------------------
    // Build model record
    // -------------------------------------------------------------------------

    const modelRecord: Record<string, unknown> = {
        model_name: model,
    };

    for (const prop of MODEL_PROPS) {
        if (prop in def) {
            modelRecord[prop] = def[prop];
        }
    }

    // -------------------------------------------------------------------------
    // Upsert model (lookup by model_name, then create or update)
    // -------------------------------------------------------------------------

    try {
        // Check if model already exists
        let existingId: string | undefined;

        for await (const existing of ems.ops.selectAny('models', {
            where: { model_name: model },
        })) {
            existingId = (existing as Record<string, unknown>).id as string;
            break;
        }

        if (existingId) {
            // Update existing model
            const { model_name: _, ...changes } = modelRecord;

            if (Object.keys(changes).length > 0) {
                await ems.ops.updateOne('models', existingId, changes);
            }
        }
        else {
            // Create new model
            await ems.ops.createOne('models', modelRecord);
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', `Failed to upsert model: ${msg}`);

        return;
    }

    // -------------------------------------------------------------------------
    // Upsert fields (lookup by model_name + field_name, then create or update)
    // -------------------------------------------------------------------------

    for (const [fieldName, fieldDef] of Object.entries(fieldsObj)) {
        if (typeof fieldDef !== 'object' || fieldDef === null) {
            yield respond.error('EINVAL', `Field '${fieldName}' definition must be an object`);

            return;
        }

        const fieldRecord: Record<string, unknown> = {
            model_name: model,
            field_name: fieldName,
            ...(fieldDef as Record<string, unknown>),
        };

        try {
            // Check if field already exists
            let existingId: string | undefined;

            for await (const existing of ems.ops.selectAny('fields', {
                where: { model_name: model, field_name: fieldName },
            })) {
                existingId = (existing as Record<string, unknown>).id as string;
                break;
            }

            if (existingId) {
                // Update existing field
                const { model_name: _m, field_name: _f, ...changes } = fieldRecord;

                if (Object.keys(changes).length > 0) {
                    await ems.ops.updateOne('fields', existingId, changes);
                }
            }
            else {
                // Create new field
                await ems.ops.createOne('fields', fieldRecord);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            yield respond.error('EIO', `Failed to upsert field '${fieldName}': ${msg}`);

            return;
        }
    }

    // -------------------------------------------------------------------------
    // Success
    // -------------------------------------------------------------------------

    yield respond.ok();
}
