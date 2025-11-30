import type { System } from '@src/lib/system.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * Bulk operation types supported by the Bulk API
 */
export enum BulkOperationType {
    // Read operations
    Select = 'select',
    SelectAll = 'select-all',
    SelectOne = 'select-one',
    Select404 = 'select-404',
    SelectMax = 'select-max',
    Count = 'count',
    Aggregate = 'aggregate',

    // Write operations
    Create = 'create',
    CreateAll = 'create-all',
    CreateOne = 'create-one',
    Update = 'update',
    UpdateAll = 'update-all',
    UpdateOne = 'update-one',
    UpdateAny = 'update-any',
    Update404 = 'update-404',
    Delete = 'delete',
    DeleteAll = 'delete-all',
    DeleteOne = 'delete-one',
    DeleteAny = 'delete-any',
    Delete404 = 'delete-404',
    Upsert = 'upsert',
    UpsertAll = 'upsert-all',
    UpsertOne = 'upsert-one',

    // Access control operations
    Access = 'access',
    AccessAll = 'access-all',
    AccessOne = 'access-one',
    AccessAny = 'access-any',
    Access404 = 'access-404',
}

/**
 * Individual bulk operation definition
 */
export interface BulkOperation {
    operation: BulkOperationType;
    model: string;
    data?: any;
    filter?: any;
    id?: string;
    message?: string;
    aggregate?: Record<string, any>;
    groupBy?: string[] | string;
    where?: any;
    result?: any; // Populated after execution
}

/**
 * Bulk operation request structure
 */
export interface BulkRequest {
    operations: BulkOperation[];
}

/**
 * BulkProcessor - Handles batch operations with proper validation and execution
 *
 * Provides clean separation of concerns:
 * - Request validation and normalization
 * - Operation execution with error handling
 * - Result compilation and formatting
 *
 * Designed for atomic transaction integration via withTransactionParams.
 */
export class BulkProcessor {
    constructor(private system: System) {}

    /**
     * Process bulk request with comprehensive validation and execution
     */
    async process(requestBody: any): Promise<BulkOperation[]> {
        // Validate and extract operations
        const operations = this.validateRequest(requestBody);

        // Validate individual operations
        this.validateOperations(operations);

        // Execute all operations
        await this.executeOperations(operations);

        return operations;
    }

    /**
     * Validate bulk request structure and extract operations
     */
    private validateRequest(requestBody: any): BulkOperation[] {
        if (!requestBody || typeof requestBody !== 'object') {
            throw HttpErrors.badRequest('Request body must be an object', 'BODY_NOT_OBJECT');
        }

        if (!requestBody.operations || !Array.isArray(requestBody.operations)) {
            throw HttpErrors.badRequest('Request body must contain an operations array', 'BODY_MISSING_FIELD');
        }

        return requestBody.operations;
    }

    /**
     * Validate individual operation requirements
     */
    private validateOperations(operations: BulkOperation[]): void {
        if (operations.length === 0) {
            return; // Empty operations array is valid
        }

        for (let i = 0; i < operations.length; i++) {
            const op = operations[i];

            // Basic required fields
            if (!op.operation || !op.model) {
                throw HttpErrors.badRequest(
                    `Operation at index ${i} missing required fields: operation and model are required`,
                    'OPERATION_MISSING_FIELDS'
                );
            }

            // Operation-specific validation
            this.validateOperationRequirements(op, i);
        }
    }

    /**
     * Validate operation-specific field requirements
     */
    private validateOperationRequirements(op: BulkOperation, index: number): void {
        // Operations requiring ID (single-record operations)
        const requiresId = [
            BulkOperationType.SelectOne,
            BulkOperationType.UpdateOne,
            BulkOperationType.DeleteOne,
            BulkOperationType.AccessOne
        ];

        if (requiresId.includes(op.operation)) {
            if (typeof op.id !== 'string' || op.id.trim().length === 0) {
                throw HttpErrors.badRequest(
                    `Operation at index ${index} (${op.operation}) requires id field`,
                    'OPERATION_MISSING_ID'
                );
            }
        }

        // Operations requiring ID or filter (*-404 operations use filter internally)
        const requiresIdOrFilter = [
            BulkOperationType.Select404,
            BulkOperationType.Update404,
            BulkOperationType.Delete404,
            BulkOperationType.Access404
        ];

        if (requiresIdOrFilter.includes(op.operation)) {
            const hasId = typeof op.id === 'string' && op.id.trim().length > 0;
            const hasFilter = typeof op.filter === 'object' && op.filter !== null;
            if (!hasId && !hasFilter) {
                throw HttpErrors.badRequest(
                    `Operation at index ${index} (${op.operation}) requires id or filter field`,
                    'OPERATION_MISSING_ID'
                );
            }
        }

        // Operations requiring data
        const requiresData = [
            BulkOperationType.Create,
            BulkOperationType.CreateOne,
            BulkOperationType.CreateAll,
            BulkOperationType.Update,
            BulkOperationType.UpdateOne,
            BulkOperationType.UpdateAll,
            BulkOperationType.UpdateAny,
            BulkOperationType.Update404,
            BulkOperationType.Upsert,
            BulkOperationType.UpsertOne,
            BulkOperationType.UpsertAll,
            BulkOperationType.DeleteAll,
            BulkOperationType.Access,
            BulkOperationType.AccessOne,
            BulkOperationType.AccessAll,
            BulkOperationType.AccessAny,
            BulkOperationType.Access404
        ];

        if (requiresData.includes(op.operation) && (op.data === undefined || op.data === null)) {
            throw HttpErrors.badRequest(
                `Operation at index ${index} (${op.operation}) requires data field`,
                'OPERATION_MISSING_DATA'
            );
        }

        const arrayDataOperations = [
            BulkOperationType.CreateAll,
            BulkOperationType.UpdateAll,
            BulkOperationType.DeleteAll,
            BulkOperationType.AccessAll,
            BulkOperationType.UpsertAll
        ];

        if (arrayDataOperations.includes(op.operation)) {
            if (!Array.isArray(op.data)) {
                throw HttpErrors.badRequest(
                    `Operation at index ${index} (${op.operation}) requires data to be an array`,
                    'OPERATION_INVALID_DATA'
                );
            }

            for (let itemIndex = 0; itemIndex < op.data.length; itemIndex++) {
                const item = op.data[itemIndex];
                if (typeof item !== 'object' || item === null) {
                    throw HttpErrors.badRequest(
                        `Operation at index ${index} (${op.operation}) requires each array item to be an object`,
                        'OPERATION_INVALID_DATA'
                    );
                }

                const requiresItemId = [
                    BulkOperationType.UpdateAll,
                    BulkOperationType.DeleteAll,
                    BulkOperationType.AccessAll
                ];
                if (requiresItemId.includes(op.operation)) {
                    if (typeof (item as any).id !== 'string' || (item as any).id.trim().length === 0) {
                        throw HttpErrors.badRequest(
                            `Operation at index ${index} (${op.operation}) requires each array item to include an id`,
                            'OPERATION_MISSING_ID'
                        );
                    }
                }
            }
        }

        const objectDataOperations = [
            BulkOperationType.Create,
            BulkOperationType.CreateOne,
            BulkOperationType.Update,
            BulkOperationType.UpdateOne,
            BulkOperationType.UpdateAny,
            BulkOperationType.Update404,
            BulkOperationType.Upsert,
            BulkOperationType.UpsertOne,
            BulkOperationType.Access,
            BulkOperationType.AccessOne,
            BulkOperationType.AccessAny,
            BulkOperationType.Access404
        ];

        if (objectDataOperations.includes(op.operation)) {
            if (typeof op.data !== 'object' || Array.isArray(op.data) || op.data === null) {
                throw HttpErrors.badRequest(
                    `Operation at index ${index} (${op.operation}) requires data to be an object`,
                    'OPERATION_INVALID_DATA'
                );
            }
        }

        const requiresFilter = [
            BulkOperationType.UpdateAny,
            BulkOperationType.DeleteAny,
            BulkOperationType.AccessAny
        ];

        if (requiresFilter.includes(op.operation)) {
            if (typeof op.filter !== 'object' || op.filter === null) {
                throw HttpErrors.badRequest(
                    `Operation at index ${index} (${op.operation}) requires filter to be an object`,
                    'OPERATION_MISSING_FILTER'
                );
            }
        }

        const disallowFilter = [
            BulkOperationType.UpdateAll,
            BulkOperationType.DeleteAll,
            BulkOperationType.AccessAll
        ];

        if (disallowFilter.includes(op.operation) && op.filter !== undefined && op.filter !== null) {
            throw HttpErrors.badRequest(
                `Operation at index ${index} (${op.operation}) does not support filter; use update-any/delete-any/access-any instead`,
                'OPERATION_INVALID_FILTER'
            );
        }

        if (op.operation === BulkOperationType.Aggregate) {
            if (typeof op.aggregate !== 'object' || op.aggregate === null || Array.isArray(op.aggregate)) {
                throw HttpErrors.badRequest(
                    `Operation at index ${index} (${op.operation}) requires aggregate to be an object`,
                    'OPERATION_MISSING_AGGREGATE'
                );
            }

            if (Object.keys(op.aggregate).length === 0) {
                throw HttpErrors.badRequest(
                    `Operation at index ${index} (${op.operation}) requires aggregate to include at least one aggregation`,
                    'OPERATION_MISSING_AGGREGATE'
                );
            }

            if (op.data !== undefined) {
                throw HttpErrors.badRequest(
                    `Operation at index ${index} (${op.operation}) does not use data; remove data and use aggregate/groupBy/filter fields`,
                    'OPERATION_INVALID_DATA'
                );
            }

            if (op.groupBy !== undefined && !Array.isArray(op.groupBy) && typeof op.groupBy !== 'string') {
                throw HttpErrors.badRequest(
                    `Operation at index ${index} (${op.operation}) requires groupBy to be a string or array of strings`,
                    'OPERATION_INVALID_GROUP_BY'
                );
            }
        }
    }

    /**
     * Execute all operations sequentially (within transaction if using withTransactionParams)
     */
    private async executeOperations(operations: BulkOperation[]): Promise<void> {
        for (let i = 0; i < operations.length; i++) {
            try {
                operations[i].result = await this.executeOperation(operations[i]);

                console.info('Bulk operation completed', {
                    index: i,
                    operation: operations[i].operation,
                    model: operations[i].model
                });
            } catch (error) {
                console.warn('Bulk operation failed', {
                    index: i,
                    operation: operations[i].operation,
                    model: operations[i].model,
                    error: error instanceof Error ? error.message : String(error)
                });
                throw error; // Re-throw to trigger transaction rollback
            }
        }
    }

    /**
     * Execute individual operation with proper database method mapping
     */
    private async executeOperation(op: BulkOperation): Promise<any> {
        const { model: modelName, data, filter, id, message } = op;
        const filterById = { where: { id: id || null }};

        switch (op.operation) {
            // Read operations
            case BulkOperationType.Select:
            case BulkOperationType.SelectAll:
                return await this.system.database.selectAny(modelName, filter);

            case BulkOperationType.SelectOne:
                return await this.system.database.selectOne(modelName, filter || filterById);

            case BulkOperationType.Select404:
                return await this.system.database.select404(modelName, filter || filterById, message);

            case BulkOperationType.SelectMax:
                // TODO: Implement selectMax functionality
                console.warn('SelectMax operation not yet implemented');
                return [];

            case BulkOperationType.Count:
                return await this.system.database.count(modelName, filter);

            case BulkOperationType.Aggregate: {
                // Build aggregate request body
                const body: any = {
                    aggregate: op.aggregate!
                };

                // Add where clause if present
                if (filter?.where) {
                    body.where = filter.where;
                } else if (op.where) {
                    body.where = op.where;
                }

                // Add groupBy if present
                if (op.groupBy) {
                    body.groupBy = Array.isArray(op.groupBy)
                        ? op.groupBy
                        : [op.groupBy];
                }

                return await this.system.database.aggregate(modelName, body);
            }

            // Write operations
            case BulkOperationType.Create:
            case BulkOperationType.CreateOne:
                return await this.system.database.createOne(modelName, data);

            case BulkOperationType.CreateAll:
                return await this.system.database.createAll(modelName, data);

            case BulkOperationType.Update:
            case BulkOperationType.UpdateOne:
                if (!id) throw HttpErrors.badRequest('ID required for updateOne operation', 'OPERATION_MISSING_ID');
                return await this.system.database.updateOne(modelName, id, data);

            case BulkOperationType.UpdateAll:
                return await this.system.database.updateAll(modelName, data);

            case BulkOperationType.UpdateAny:
                return await this.system.database.updateAny(modelName, filter, data);

            case BulkOperationType.Update404:
                return await this.system.database.update404(modelName, filter || filterById, data, message);

            case BulkOperationType.Delete:
            case BulkOperationType.DeleteOne:
                if (!id) throw HttpErrors.badRequest('ID required for deleteOne operation', 'OPERATION_MISSING_ID');
                return await this.system.database.deleteOne(modelName, id);

            case BulkOperationType.DeleteAll:
                return await this.system.database.deleteAll(modelName, data);

            case BulkOperationType.DeleteAny:
                return await this.system.database.deleteAny(modelName, filter);

            case BulkOperationType.Delete404:
                return await this.system.database.delete404(modelName, filter || filterById, message);

            case BulkOperationType.Upsert:
            case BulkOperationType.UpsertOne:
                return await this.system.database.upsertOne(modelName, data);

            case BulkOperationType.UpsertAll:
                return await this.system.database.upsertAll(modelName, data);

            // Access control operations
            case BulkOperationType.Access:
            case BulkOperationType.AccessOne:
                if (!id) throw HttpErrors.badRequest('ID required for accessOne operation', 'OPERATION_MISSING_ID');
                return await this.system.database.accessOne(modelName, id, data);

            case BulkOperationType.AccessAll:
                return await this.system.database.accessAll(modelName, data);

            case BulkOperationType.AccessAny:
                return await this.system.database.accessAny(modelName, filter, data);

            case BulkOperationType.Access404:
                return await this.system.database.access404(modelName, filter || filterById, data, message);

            default:
                throw HttpErrors.unprocessableEntity(`Unsupported operation: ${op.operation}`, 'OPERATION_UNSUPPORTED');
        }
    }
}
