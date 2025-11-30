/**
 * Database Mutate Operations
 *
 * All write operations for the Database service.
 * These operations go through the observer pipeline.
 */

import type { SystemContext } from '@src/lib/system-context-types.js';
import type { FilterData } from '@src/lib/filter-types.js';
import type { DbRecord, DbCreateInput, DbUpdateInput, DbDeleteInput, DbRevertInput } from '@src/lib/database-types.js';
import type { SelectOptions } from './types.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { runObserverPipeline } from './pipeline.js';
import { selectAny } from './select.js';

// Type for the selectAny function signature
type SelectAnyFn = (modelName: string, filterData: any, options: SelectOptions) => Promise<any[]>;

/**
 * Create a bound selectAny function for the pipeline
 */
function boundSelectAny(system: SystemContext): SelectAnyFn {
    return (modelName, filterData, options) => selectAny(system, modelName, filterData, options);
}

// ============================================================================
// CREATE Operations
// ============================================================================

/**
 * Create multiple records through observer pipeline
 */
export async function createAll<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    records: DbCreateInput<T>[]
): Promise<DbRecord<T>[]> {
    return await runObserverPipeline(system, 'create', modelName, records, boundSelectAny(system));
}

/**
 * Create a single record through observer pipeline
 */
export async function createOne<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    recordData: DbCreateInput<T>
): Promise<DbRecord<T>> {
    const results = await createAll<T>(system, modelName, [recordData]);
    return results[0];
}

// ============================================================================
// UPDATE Operations
// ============================================================================

/**
 * Update multiple records through observer pipeline
 */
export async function updateAll<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    updates: DbUpdateInput<T>[]
): Promise<DbRecord<T>[]> {
    return await runObserverPipeline(system, 'update', modelName, updates, boundSelectAny(system));
}

/**
 * Update a single record by ID
 */
export async function updateOne<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    recordId: string,
    updates: Partial<T>
): Promise<DbRecord<T>> {
    const results = await updateAll<T>(system, modelName, [{ id: recordId, ...updates }]);

    if (results.length === 0) {
        throw HttpErrors.notFound('Record not found', 'RECORD_NOT_FOUND');
    }

    return results[0];
}

/**
 * Update multiple records by their IDs
 */
export async function updateIds<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    ids: string[],
    changes: Partial<T>
): Promise<DbRecord<T>[]> {
    if (ids.length === 0) return [];
    return await updateAny<T>(system, modelName, { where: { id: { $in: ids } } }, changes);
}

/**
 * Update records matching filter criteria
 */
export async function updateAny<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    filterData: FilterData,
    changes: Partial<T>
): Promise<DbRecord<T>[]> {
    const records = await selectAny<T>(system, modelName, filterData, { context: 'system' });

    if (records.length === 0) {
        return [];
    }

    const updates = records.map(record => ({
        id: record.id,
        ...changes,
    }));

    return await updateAll<T>(system, modelName, updates);
}

/**
 * Update record by filter or throw 404 error
 */
export async function update404<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    filter: FilterData,
    changes: Partial<T>,
    message?: string
): Promise<DbRecord<T>> {
    const record = await selectAny<T>(system, modelName, filter, {});

    if (record.length === 0) {
        throw HttpErrors.notFound(message || 'Record not found', 'RECORD_NOT_FOUND');
    }

    return await updateOne<T>(system, modelName, record[0].id, changes);
}

// ============================================================================
// UPSERT Operations
// ============================================================================

/**
 * Upsert multiple records (insert or update based on ID presence)
 */
export async function upsertAll<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    records: (DbCreateInput<T> | DbUpdateInput<T>)[]
): Promise<DbRecord<T>[]> {
    if (records.length === 0) {
        return [];
    }

    // Split by presence of ID, tracking original indices
    const toInsert: { index: number; data: DbCreateInput<T> }[] = [];
    const toUpdate: { index: number; data: DbUpdateInput<T> }[] = [];

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if ('id' in record && record.id) {
            toUpdate.push({ index: i, data: record as DbUpdateInput<T> });
        } else {
            toInsert.push({ index: i, data: record as DbCreateInput<T> });
        }
    }

    // Run separate pipelines
    const inserted = toInsert.length
        ? await createAll<T>(system, modelName, toInsert.map(item => item.data))
        : [];
    const updated = toUpdate.length
        ? await updateAll<T>(system, modelName, toUpdate.map(item => item.data))
        : [];

    // Reconstruct original order
    const results = new Array<DbRecord<T>>(records.length);
    toInsert.forEach((item, i) => { results[item.index] = inserted[i]; });
    toUpdate.forEach((item, i) => { results[item.index] = updated[i]; });

    return results;
}

/**
 * Upsert a single record
 */
export async function upsertOne<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    record: DbCreateInput<T> | DbUpdateInput<T>
): Promise<DbRecord<T>> {
    const results = await upsertAll<T>(system, modelName, [record]);
    return results[0];
}

// ============================================================================
// DELETE Operations (Soft Delete)
// ============================================================================

/**
 * Soft delete multiple records
 */
export async function deleteAll<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    deletes: DbDeleteInput[]
): Promise<DbRecord<T>[]> {
    return await runObserverPipeline(system, 'delete', modelName, deletes, boundSelectAny(system));
}

/**
 * Soft delete a single record by ID
 */
export async function deleteOne<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    recordId: string
): Promise<DbRecord<T>> {
    const results = await deleteAll<T>(system, modelName, [{ id: recordId }]);

    if (results.length === 0) {
        throw HttpErrors.notFound('Record not found or already trashed', 'RECORD_NOT_FOUND');
    }

    return results[0];
}

/**
 * Soft delete multiple records by their IDs
 */
export async function deleteIds<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    ids: string[]
): Promise<DbRecord<T>[]> {
    if (ids.length === 0) return [];
    const deleteRecords = ids.map(id => ({ id }));
    return await deleteAll<T>(system, modelName, deleteRecords);
}

/**
 * Soft delete records matching filter criteria
 */
export async function deleteAny<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    filter: FilterData
): Promise<DbRecord<T>[]> {
    const records = await selectAny<T>(system, modelName, filter, { context: 'system' });

    if (records.length === 0) {
        return [];
    }

    const recordIds = records.map(record => record.id);
    return await deleteIds<T>(system, modelName, recordIds);
}

/**
 * Soft delete record by filter or throw 404 error
 */
export async function delete404<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    filter: FilterData,
    message?: string
): Promise<DbRecord<T>> {
    const records = await selectAny<T>(system, modelName, filter, {});

    if (records.length === 0) {
        throw HttpErrors.notFound(message || 'Record not found', 'RECORD_NOT_FOUND');
    }

    return await deleteOne<T>(system, modelName, records[0].id);
}

// ============================================================================
// REVERT Operations (Undo Soft Delete)
// ============================================================================

/**
 * Revert multiple soft-deleted records
 */
export async function revertAll<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    reverts: DbRevertInput[]
): Promise<DbRecord<T>[]> {
    return await runObserverPipeline(system, 'revert', modelName, reverts, boundSelectAny(system));
}

/**
 * Revert a single soft-deleted record
 */
export async function revertOne<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    recordId: string
): Promise<DbRecord<T>> {
    const results = await revertAll<T>(system, modelName, [{ id: recordId, trashed_at: null }]);

    if (results.length === 0) {
        throw HttpErrors.notFound('Record not found or not trashed', 'RECORD_NOT_FOUND');
    }

    return results[0];
}

/**
 * Revert multiple records using filter criteria
 *
 * Automatically queries with trashed: 'include' to find trashed records.
 */
export async function revertAny<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    filterData: FilterData = {}
): Promise<DbRecord<T>[]> {
    const trashedRecords = await selectAny<T>(system, modelName, filterData, { trashed: 'include', context: 'system' });
    const recordsToRevert = trashedRecords
        .filter(record => record.trashed_at !== null)
        .map(record => ({ id: record.id, trashed_at: null as null }));

    if (recordsToRevert.length === 0) {
        return [];
    }

    return await revertAll<T>(system, modelName, recordsToRevert);
}

// ============================================================================
// EXPIRE Operations (Permanent Delete - sets deleted_at)
// ============================================================================

/**
 * Permanently delete multiple records by setting deleted_at
 *
 * This is irreversible - records will no longer be visible via API.
 */
export async function expireAll<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    expires: DbDeleteInput[]
): Promise<DbRecord<T>[]> {
    return await runObserverPipeline(system, 'expire', modelName, expires, boundSelectAny(system));
}

/**
 * Permanently delete a single record by ID
 */
export async function expireOne<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    recordId: string
): Promise<DbRecord<T>> {
    const results = await expireAll<T>(system, modelName, [{ id: recordId }]);

    if (results.length === 0) {
        throw HttpErrors.notFound('Record not found', 'RECORD_NOT_FOUND');
    }

    return results[0];
}
