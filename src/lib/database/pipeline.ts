/**
 * Observer Pipeline Execution
 *
 * Handles execution of the observer pipeline for database mutations.
 * Extracted from Database class for better separation of concerns.
 */

import type { SystemContext } from '@src/lib/system-context-types.js';
import type { Model } from '@src/lib/model.js';
import type { OperationType } from '@src/lib/observers/types.js';
import { ModelRecord } from '@src/lib/model-record.js';
import { ObserverRunner } from '@src/lib/observers/runner.js';
import { ObserverRecursionError, SystemError } from '@src/lib/observers/errors.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { SQL_MAX_RECURSION } from '@src/lib/constants.js';
import type { SelectOptions } from './types.js';

/**
 * Run observer pipeline for a database operation
 *
 * Executes the complete observer pipeline for any database operation.
 * Handles recursion detection, transaction management, and selective ring execution.
 *
 * @param system - System context with infrastructure
 * @param operation - Operation type (create, update, delete, revert, access)
 * @param modelName - Model name to operate on
 * @param data - Array of record data
 * @param selectAnyFn - Function to select records (for preloading)
 * @param depth - Current recursion depth
 * @returns Array of processed records
 */
export async function runObserverPipeline(
    system: SystemContext,
    operation: OperationType,
    modelName: string,
    data: any[],
    selectAnyFn: (modelName: string, filterData: any, options: SelectOptions) => Promise<any[]>,
    depth: number = 0
): Promise<any[]> {
    // Recursion protection
    if (depth > SQL_MAX_RECURSION) {
        throw new ObserverRecursionError(depth, SQL_MAX_RECURSION);
    }

    const startTime = Date.now();

    console.info('Observer pipeline started', {
        operation,
        modelName,
        recordCount: data.length,
        depth,
    });

    // Get model from namespace cache
    const model = system.namespace.getModel(modelName);

    try {
        // Execute observer pipeline with resolved model object
        const result = await executeObserverPipeline(
            system,
            operation,
            model,
            data,
            selectAnyFn,
            depth + 1
        );

        // Performance timing for successful pipeline
        const duration = Date.now() - startTime;
        console.info('Observer pipeline completed', {
            operation,
            modelName: model.model_name,
            recordCount: data.length,
            depth,
            durationMs: duration,
        });

        return result;
    } catch (error) {
        console.warn('Observer pipeline failed', {
            operation,
            modelName: model.model_name,
            recordCount: data.length,
            depth,
            error: error instanceof Error ? error.message : String(error),
        });

        throw error instanceof Error ? error : new SystemError(`Observer pipeline failed: ${error}`);
    }
}

/**
 * Execute observer pipeline within existing transaction context
 */
async function executeObserverPipeline(
    system: SystemContext,
    operation: OperationType,
    model: Model,
    data: any[],
    selectAnyFn: (modelName: string, filterData: any, options: SelectOptions) => Promise<any[]>,
    depth: number
): Promise<any[]> {
    // Wrap input data in ModelRecord instances AND collect IDs in single pass
    const records: ModelRecord[] = [];
    const ids: string[] = [];

    for (const d of data) {
        const record = new ModelRecord(model, d);
        records.push(record);

        // Collect IDs for preloading (non-create operations only)
        if (operation === 'create') {
            continue;
        }

        const id = record.get('id');

        if (typeof id === 'string') {
            ids.push(id);
        }
    }

    // Preload existing records for update/delete/revert/access operations
    // Single batch query, then single pass to set originals
    if (ids.length > 0) {
        await preloadExistingRecords(model.model_name, records, ids, selectAnyFn);
    }

    const runner = new ObserverRunner();

    const result = await runner.execute(
        system,
        operation,
        model,
        records,
        depth
    );

    if (!result.success) {
        // Convert observer validation errors to structured HTTP errors
        const errors = result.errors || [];

        if (errors.length === 0) {
            throw HttpErrors.internal('Observer pipeline failed without error details', 'OBSERVER_PIPELINE_FAILED');
        }

        // Use the first error's code, or default to VALIDATION_ERROR
        const primaryError = errors[0];
        const errorCode = primaryError.code || 'VALIDATION_ERROR';

        // Create structured error response with all validation errors
        throw HttpErrors.unprocessableEntity(
            primaryError.message,
            errorCode,
            {
                validation_errors: errors.map(e => ({
                    message: e.message,
                    code: e.code,
                    field: (e as any).field
                })),
                error_count: errors.length
            }
        );
    }

    // Unwrap ModelRecord instances back to plain objects
    return records.map((r: ModelRecord) => r.toObject());
}

/**
 * Preload existing records for update/delete/revert/access operations
 *
 * This was previously handled by the Ring 0 record-preloader observer.
 * Moving it here preserves batch query performance while simplifying the observer pipeline.
 *
 * @param modelName - Model to preload records from
 * @param records - ModelRecord instances to populate with original data
 * @param ids - Pre-extracted IDs to query
 * @param selectAnyFn - Function to select records
 */
async function preloadExistingRecords(
    modelName: string,
    records: ModelRecord[],
    ids: string[],
    selectAnyFn: (modelName: string, filterData: any, options: SelectOptions) => Promise<any[]>
): Promise<void> {
    // Batch query for existing records - include trashed for revert operations
    const existingRows = await selectAnyFn(modelName, { where: { id: { $in: ids } } }, {
        trashed: 'include',
        context: 'system'
    });

    // Create lookup map by ID
    const existingById = new Map(existingRows.map(row => [row.id, row]));

    // Load original data into each ModelRecord
    for (const record of records) {
        const id = record.get('id');
        const existing = existingById.get(id);

        if (existing) {
            record.load(existing);
        }
    }

    console.info('Preloaded existing records for pipeline', {
        modelName,
        requestedCount: ids.length,
        foundCount: existingRows.length
    });
}
