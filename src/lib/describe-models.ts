import type { System } from '@src/lib/system.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import type { FilterData } from '@src/lib/filter-types.js';
import type {
    ModelRecord,
    DbCreateInput,
    SystemFields,
} from '@src/lib/database-types.js';

/**
 * DescribeModels - Wrapper for model operations on 'models' table
 *
 * Provides Database-like interface for model metadata operations.
 *
 * Note: Model sudo protection is handled by the 20-model-sudo-validator observer
 * which runs in Ring 1 for all create/update/delete operations.
 */
export class DescribeModels {
    constructor(private system: System) {}

    /**
     * Select multiple models with optional filtering
     */
    async selectAny(filter?: FilterData, options?: { context?: 'api' | 'observer' | 'system' }): Promise<ModelRecord[]> {
        return this.system.database.selectAny<ModelRecord>('models', filter, options);
    }

    /**
     * Select single model (returns null if not found)
     */
    async selectOne(filter: FilterData, options?: { context?: 'api' | 'observer' | 'system' }): Promise<ModelRecord | null> {
        return this.system.database.selectOne<ModelRecord>('models', filter, options);
    }

    /**
     * Select single model (throws 404 if not found)
     */
    async select404(filter: FilterData, message?: string, options?: { context?: 'api' | 'observer' | 'system' }): Promise<ModelRecord> {
        return await this.system.database.select404<ModelRecord>('models', filter, message, options)
            .catch(e => HttpErrors.remap(e, 'RECORD_NOT_FOUND', 'MODEL_NOT_FOUND'));
    }

    /**
     * Create new model
     *
     * Observer pipeline will handle DDL generation (CREATE TABLE).
     */
    async createOne(data: DbCreateInput<Omit<ModelRecord, keyof SystemFields>>): Promise<ModelRecord> {
        // Validate required fields
        if (!data.model_name) {
            throw HttpErrors.badRequest('model_name is required', 'MISSING_REQUIRED_FIELDS');
        }

        console.info('Creating model via observer pipeline', data);

        // Delegate to database
        return this.system.database.createOne<Omit<ModelRecord, keyof SystemFields>>('models', data) as Promise<ModelRecord>;
    }

    /**
     * Update model by filter (throws 404 if not found)
     */
    async update404(filter: FilterData, updates: Partial<ModelRecord>, message?: string): Promise<ModelRecord> {
        // Extract model name for logging
        const modelName = filter.where?.model_name;

        // Validate at least one field provided
        if (Object.keys(updates).length === 0) {
            throw HttpErrors.badRequest('No valid fields to update', 'NO_UPDATES');
        }

        console.info('Updating model metadata', { modelName, updates });

        return await this.system.database.update404<ModelRecord>('models', filter, updates, message)
            .catch(e => HttpErrors.remap(e, 'RECORD_NOT_FOUND', 'MODEL_NOT_FOUND'));
    }

    /**
     * Delete model by filter (throws 404 if not found)
     *
     * Observer pipeline will handle DDL (DROP TABLE).
     */
    async delete404(filter: FilterData, message?: string): Promise<ModelRecord> {
        // Extract model name for logging
        const modelName = filter.where?.model_name;

        console.info('Deleting model via observer pipeline', { modelName });

        return await this.system.database.delete404<ModelRecord>('models', filter, message)
            .catch(e => HttpErrors.remap(e, 'RECORD_NOT_FOUND', 'MODEL_NOT_FOUND'));
    }
}
