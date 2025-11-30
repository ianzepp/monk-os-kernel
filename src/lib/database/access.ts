/**
 * Database Access Control Operations
 *
 * ACL operations for the Database service.
 * These operations go through the observer pipeline but only modify access_* fields.
 */

import type { SystemContext } from '@src/lib/system-context-types.js';
import type { FilterData } from '@src/lib/filter-types.js';
import type { DbRecord, DbAccessInput, DbAccessUpdate } from '@src/lib/database-types.js';
import type { SelectOptions } from './types.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { runObserverPipeline } from './pipeline.js';
import { selectAny, select404 } from './select.js';

// Type for the selectAny function signature
type SelectAnyFn = (modelName: string, filterData: any, options: SelectOptions) => Promise<any[]>;

/**
 * Create a bound selectAny function for the pipeline
 */
function boundSelectAny(system: SystemContext): SelectAnyFn {
    return (modelName, filterData, options) => selectAny(system, modelName, filterData, options);
}

/**
 * Update access control lists (ACLs) for multiple records
 */
export async function accessAll<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    accessUpdates: DbAccessUpdate[]
): Promise<DbRecord<T>[]> {
    return await runObserverPipeline(system, 'access', modelName, accessUpdates, boundSelectAny(system));
}

/**
 * Update access control lists (ACLs) for a single record
 */
export async function accessOne<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    recordId: string,
    accessChanges: DbAccessInput
): Promise<DbRecord<T>> {
    const results = await accessAll<T>(system, modelName, [{ id: recordId, ...accessChanges }]);

    if (results.length === 0) {
        throw HttpErrors.notFound('Record not found', 'RECORD_NOT_FOUND');
    }

    return results[0];
}

/**
 * Update access control lists (ACLs) for records matching a filter
 */
export async function accessAny<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    filter: FilterData,
    accessChanges: DbAccessInput
): Promise<DbRecord<T>[]> {
    const records = await selectAny<T>(system, modelName, filter, { context: 'system' });

    if (records.length === 0) {
        return [];
    }

    const accessUpdates = records.map(record => ({
        id: record.id,
        ...accessChanges,
    }));

    return await accessAll<T>(system, modelName, accessUpdates);
}

/**
 * Update ACLs for record by filter or throw 404 error
 */
export async function access404<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    filter: FilterData,
    accessChanges: DbAccessInput,
    message?: string
): Promise<DbRecord<T>> {
    const record = await select404<T>(system, modelName, filter, message);
    return await accessOne<T>(system, modelName, record.id, accessChanges);
}
