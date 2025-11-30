/**
 * Database Service
 *
 * High-level database operations providing:
 * - Select operations (read-only, no observer pipeline)
 * - Mutate operations (create/update/delete via observer pipeline)
 * - Access control operations (ACL modifications via observer pipeline)
 *
 * Per-request instance with specific database context.
 * Uses dependency injection pattern to break circular dependencies.
 */

import type { SystemContext } from '@src/lib/system-context-types.js';
import type { FilterData } from '@src/lib/filter-types.js';
import type {
    DbRecord,
    DbCreateInput,
    DbUpdateInput,
    DbDeleteInput,
    DbRevertInput,
    DbAccessInput,
    DbAccessUpdate,
} from '@src/lib/database-types.js';
import type { SelectOptions, CachedRelationship } from './types.js';
import type { ModelName } from '@src/lib/model.js';

// Import operations from modules
import * as selectOps from './select.js';
import * as mutateOps from './mutate.js';
import * as accessOps from './access.js';
import * as exportOps from './export.js';
import type { ExportOptions, ExportResult } from './export.js';
import * as importOps from './import.js';
import type { ImportOptions, ImportResult } from './import.js';

/**
 * Database service wrapper providing high-level operations
 * Per-request instance with specific database context
 */
export class Database {
    public readonly system: SystemContext;

    constructor(system: SystemContext) {
        this.system = system;
    }

    // ========================================================================
    // Low-level Operations
    // ========================================================================

    async execute(query: string, params: any[] = []): Promise<any> {
        return selectOps.execute(this.system, query, params);
    }

    async getRelationship(parentModel: string, relationshipName: string): Promise<CachedRelationship> {
        return selectOps.getRelationship(this.system, parentModel, relationshipName);
    }

    // ========================================================================
    // Aggregation Operations
    // ========================================================================

    async count(modelName: ModelName, filterData: FilterData = {}, options: SelectOptions = {}): Promise<number> {
        return selectOps.count(this.system, modelName, filterData, options);
    }

    async aggregate(modelName: ModelName, body: any = {}, options: SelectOptions = {}): Promise<any[]> {
        return selectOps.aggregate(this.system, modelName, body, options);
    }

    // ========================================================================
    // Select Operations
    // ========================================================================

    async selectAny<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filterData: FilterData = {},
        options: SelectOptions = {}
    ): Promise<DbRecord<T>[]> {
        return selectOps.selectAny<T>(this.system, modelName, filterData, options);
    }

    async selectOne<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filterData: FilterData,
        options: SelectOptions = {}
    ): Promise<DbRecord<T> | null> {
        return selectOps.selectOne<T>(this.system, modelName, filterData, options);
    }

    async select404<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filter: FilterData,
        message?: string,
        options: SelectOptions = {}
    ): Promise<DbRecord<T>> {
        return selectOps.select404<T>(this.system, modelName, filter, message, options);
    }

    async selectIds<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        ids: string[],
        options: SelectOptions = {}
    ): Promise<DbRecord<T>[]> {
        return selectOps.selectIds<T>(this.system, modelName, ids, options);
    }

    async selectAll<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        records: DbRecord<T>[]
    ): Promise<DbRecord<T>[]> {
        return selectOps.selectAll<T>(this.system, modelName, records);
    }

    // ========================================================================
    // Stream Operations
    // ========================================================================

    /**
     * Stream records matching filter criteria
     *
     * Returns an async generator that yields records one at a time.
     * Use for large result sets or when streaming to clients (JSONL, MCP, MQTT).
     *
     * @example
     * // Stream all records
     * for await (const record of db.streamAny('orders')) {
     *     console.log(record);
     * }
     *
     * // Stream with filter
     * for await (const record of db.streamAny('orders', { where: { status: 'pending' } })) {
     *     process(record);
     * }
     */
    streamAny<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filterData: FilterData = {},
        options: SelectOptions = {}
    ): AsyncGenerator<DbRecord<T>, void, unknown> {
        return selectOps.streamAny<T>(this.system, modelName, filterData, options);
    }

    /**
     * Stream records by their IDs
     *
     * Returns an async generator that yields records one at a time.
     */
    streamIds<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        ids: string[],
        options: SelectOptions = {}
    ): AsyncGenerator<DbRecord<T>, void, unknown> {
        return selectOps.streamIds<T>(this.system, modelName, ids, options);
    }

    // ========================================================================
    // Create Operations
    // ========================================================================

    async createAll<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        records: DbCreateInput<T>[]
    ): Promise<DbRecord<T>[]> {
        return mutateOps.createAll<T>(this.system, modelName, records);
    }

    async createOne<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        recordData: DbCreateInput<T>
    ): Promise<DbRecord<T>> {
        return mutateOps.createOne<T>(this.system, modelName, recordData);
    }

    // ========================================================================
    // Update Operations
    // ========================================================================

    async updateAll<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        updates: DbUpdateInput<T>[]
    ): Promise<DbRecord<T>[]> {
        return mutateOps.updateAll<T>(this.system, modelName, updates);
    }

    async updateOne<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        recordId: string,
        updates: Partial<T>
    ): Promise<DbRecord<T>> {
        return mutateOps.updateOne<T>(this.system, modelName, recordId, updates);
    }

    async updateIds<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        ids: string[],
        changes: Partial<T>
    ): Promise<DbRecord<T>[]> {
        return mutateOps.updateIds<T>(this.system, modelName, ids, changes);
    }

    async updateAny<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filterData: FilterData,
        changes: Partial<T>
    ): Promise<DbRecord<T>[]> {
        return mutateOps.updateAny<T>(this.system, modelName, filterData, changes);
    }

    async update404<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filter: FilterData,
        changes: Partial<T>,
        message?: string
    ): Promise<DbRecord<T>> {
        return mutateOps.update404<T>(this.system, modelName, filter, changes, message);
    }

    // ========================================================================
    // Upsert Operations
    // ========================================================================

    async upsertAll<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        records: (DbCreateInput<T> | DbUpdateInput<T>)[]
    ): Promise<DbRecord<T>[]> {
        return mutateOps.upsertAll<T>(this.system, modelName, records);
    }

    async upsertOne<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        record: DbCreateInput<T> | DbUpdateInput<T>
    ): Promise<DbRecord<T>> {
        return mutateOps.upsertOne<T>(this.system, modelName, record);
    }

    // ========================================================================
    // Delete Operations (Soft Delete)
    // ========================================================================

    async deleteAll<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        deletes: DbDeleteInput[]
    ): Promise<DbRecord<T>[]> {
        return mutateOps.deleteAll<T>(this.system, modelName, deletes);
    }

    async deleteOne<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        recordId: string
    ): Promise<DbRecord<T>> {
        return mutateOps.deleteOne<T>(this.system, modelName, recordId);
    }

    async deleteIds<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        ids: string[]
    ): Promise<DbRecord<T>[]> {
        return mutateOps.deleteIds<T>(this.system, modelName, ids);
    }

    async deleteAny<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filter: FilterData
    ): Promise<DbRecord<T>[]> {
        return mutateOps.deleteAny<T>(this.system, modelName, filter);
    }

    async delete404<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filter: FilterData,
        message?: string
    ): Promise<DbRecord<T>> {
        return mutateOps.delete404<T>(this.system, modelName, filter, message);
    }

    // ========================================================================
    // Revert Operations (Undo Soft Delete)
    // ========================================================================

    async revertAll<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        reverts: DbRevertInput[]
    ): Promise<DbRecord<T>[]> {
        return mutateOps.revertAll<T>(this.system, modelName, reverts);
    }

    async revertOne<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        recordId: string
    ): Promise<DbRecord<T>> {
        return mutateOps.revertOne<T>(this.system, modelName, recordId);
    }

    async revertAny<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filterData: FilterData = {}
    ): Promise<DbRecord<T>[]> {
        return mutateOps.revertAny<T>(this.system, modelName, filterData);
    }

    // ========================================================================
    // Expire Operations (Permanent Delete)
    // ========================================================================

    async expireAll<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        expires: DbDeleteInput[]
    ): Promise<DbRecord<T>[]> {
        return mutateOps.expireAll<T>(this.system, modelName, expires);
    }

    async expireOne<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        recordId: string
    ): Promise<DbRecord<T>> {
        return mutateOps.expireOne<T>(this.system, modelName, recordId);
    }

    // ========================================================================
    // Access Control Operations
    // ========================================================================

    async accessAll<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        accessUpdates: DbAccessUpdate[]
    ): Promise<DbRecord<T>[]> {
        return accessOps.accessAll<T>(this.system, modelName, accessUpdates);
    }

    async accessOne<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        recordId: string,
        accessChanges: DbAccessInput
    ): Promise<DbRecord<T>> {
        return accessOps.accessOne<T>(this.system, modelName, recordId, accessChanges);
    }

    async accessAny<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filter: FilterData,
        accessChanges: DbAccessInput
    ): Promise<DbRecord<T>[]> {
        return accessOps.accessAny<T>(this.system, modelName, filter, accessChanges);
    }

    async access404<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filter: FilterData,
        accessChanges: DbAccessInput,
        message?: string
    ): Promise<DbRecord<T>> {
        return accessOps.access404<T>(this.system, modelName, filter, accessChanges, message);
    }

    // ========================================================================
    // Export Operations
    // ========================================================================

    /**
     * Export tenant data to SQLite format
     *
     * Creates an in-memory SQLite database containing model definitions and data.
     * Useful for bulk export, snapshots, backups, and data migration.
     *
     * @param options - Export options (models to include, what to export)
     * @returns Export result with SQLite buffer and metadata
     *
     * @example
     * // Export all non-system models
     * const result = await db.exportAll();
     *
     * // Export specific models, schema only
     * const result = await db.exportAll({
     *   models: ['orders', 'products'],
     *   include: ['describe']
     * });
     */
    async exportAll(options: ExportOptions = {}): Promise<ExportResult> {
        return exportOps.exportAll(this.system, options);
    }

    /**
     * Import tenant data from SQLite format
     *
     * Imports model definitions and data from an SQLite database buffer.
     * Useful for bulk import, restoring from snapshots, and data migration.
     *
     * @param buffer - SQLite database as binary buffer
     * @param options - Import options (strategy, models, include)
     * @returns Import result with statistics
     *
     * @example
     * // Import with default upsert strategy
     * const result = await db.importAll(buffer);
     *
     * // Import specific models with replace strategy
     * const result = await db.importAll(buffer, {
     *   models: ['orders', 'products'],
     *   strategy: 'replace'
     * });
     */
    async importAll(buffer: Uint8Array, options: ImportOptions = {}): Promise<ImportResult> {
        return importOps.importAll(this.system, buffer, options);
    }

    // ========================================================================
    // Convenience Aliases
    // ========================================================================

    /**
     * Create records - routes to createAll or createOne based on input type
     */
    async create<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        data: DbCreateInput<T>[]
    ): Promise<DbRecord<T>[]>;
    async create<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        data: DbCreateInput<T>
    ): Promise<DbRecord<T>>;
    async create<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        data: DbCreateInput<T> | DbCreateInput<T>[]
    ): Promise<DbRecord<T> | DbRecord<T>[]> {
        if (Array.isArray(data)) {
            return this.createAll<T>(modelName, data);
        }
        return this.createOne<T>(modelName, data);
    }

    /**
     * Insert records - alias for create
     */
    async insert<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        data: DbCreateInput<T>[]
    ): Promise<DbRecord<T>[]>;
    async insert<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        data: DbCreateInput<T>
    ): Promise<DbRecord<T>>;
    async insert<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        data: DbCreateInput<T> | DbCreateInput<T>[]
    ): Promise<DbRecord<T> | DbRecord<T>[]> {
        return this.create<T>(modelName, data as any);
    }

    async insertAll<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        records: DbCreateInput<T>[]
    ): Promise<DbRecord<T>[]> {
        return this.createAll<T>(modelName, records);
    }

    async insertOne<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        recordData: DbCreateInput<T>
    ): Promise<DbRecord<T>> {
        return this.createOne<T>(modelName, recordData);
    }

    /**
     * Select records - routes based on input type:
     * - string: selectOne by id
     * - string[]: selectIds
     * - FilterData: selectAny
     */
    async select<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: string,
        options?: SelectOptions
    ): Promise<DbRecord<T> | null>;
    async select<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: string[],
        options?: SelectOptions
    ): Promise<DbRecord<T>[]>;
    async select<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: FilterData,
        options?: SelectOptions
    ): Promise<DbRecord<T>[]>;
    async select<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: string | string[] | FilterData,
        options: SelectOptions = {}
    ): Promise<DbRecord<T> | DbRecord<T>[] | null> {
        if (typeof input === 'string') {
            return this.selectOne<T>(modelName, { where: { id: input } }, options);
        }
        if (Array.isArray(input)) {
            return this.selectIds<T>(modelName, input, options);
        }
        return this.selectAny<T>(modelName, input, options);
    }

    /**
     * Update records - routes based on input type:
     * - DbUpdateInput[]: updateAll
     * - (string, Partial<T>): updateOne
     * - (FilterData, Partial<T>): updateAny
     */
    async update<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        updates: DbUpdateInput<T>[]
    ): Promise<DbRecord<T>[]>;
    async update<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        recordId: string,
        changes: Partial<T>
    ): Promise<DbRecord<T>>;
    async update<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filter: FilterData,
        changes: Partial<T>
    ): Promise<DbRecord<T>[]>;
    async update<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        first: DbUpdateInput<T>[] | string | FilterData,
        second?: Partial<T>
    ): Promise<DbRecord<T> | DbRecord<T>[]> {
        if (Array.isArray(first)) {
            return this.updateAll<T>(modelName, first);
        }
        if (typeof first === 'string') {
            return this.updateOne<T>(modelName, first, second!);
        }
        return this.updateAny<T>(modelName, first, second!);
    }

    /**
     * Delete records - routes based on input type:
     * - string: deleteOne
     * - string[]: deleteIds
     * - FilterData: deleteAny
     */
    async delete<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: string
    ): Promise<DbRecord<T>>;
    async delete<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: string[]
    ): Promise<DbRecord<T>[]>;
    async delete<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: FilterData
    ): Promise<DbRecord<T>[]>;
    async delete<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: string | string[] | FilterData
    ): Promise<DbRecord<T> | DbRecord<T>[]> {
        if (typeof input === 'string') {
            return this.deleteOne<T>(modelName, input);
        }
        if (Array.isArray(input)) {
            return this.deleteIds<T>(modelName, input);
        }
        return this.deleteAny<T>(modelName, input);
    }

    /**
     * Upsert records - routes to upsertAll or upsertOne based on input type
     */
    async upsert<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        data: (DbCreateInput<T> | DbUpdateInput<T>)[]
    ): Promise<DbRecord<T>[]>;
    async upsert<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        data: DbCreateInput<T> | DbUpdateInput<T>
    ): Promise<DbRecord<T>>;
    async upsert<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        data: (DbCreateInput<T> | DbUpdateInput<T>) | (DbCreateInput<T> | DbUpdateInput<T>)[]
    ): Promise<DbRecord<T> | DbRecord<T>[]> {
        if (Array.isArray(data)) {
            return this.upsertAll<T>(modelName, data);
        }
        return this.upsertOne<T>(modelName, data);
    }

    /**
     * Revert records - routes based on input type:
     * - string: revertOne
     * - FilterData: revertAny
     */
    async revert<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: string
    ): Promise<DbRecord<T>>;
    async revert<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: FilterData
    ): Promise<DbRecord<T>[]>;
    async revert<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: string | FilterData
    ): Promise<DbRecord<T> | DbRecord<T>[]> {
        if (typeof input === 'string') {
            return this.revertOne<T>(modelName, input);
        }
        return this.revertAny<T>(modelName, input);
    }

    /**
     * Expire records - routes based on input type:
     * - string: expireOne
     * - DbDeleteInput[]: expireAll
     */
    async expire<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: string
    ): Promise<DbRecord<T>>;
    async expire<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: DbDeleteInput[]
    ): Promise<DbRecord<T>[]>;
    async expire<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        input: string | DbDeleteInput[]
    ): Promise<DbRecord<T> | DbRecord<T>[]> {
        if (typeof input === 'string') {
            return this.expireOne<T>(modelName, input);
        }
        return this.expireAll<T>(modelName, input);
    }

    /**
     * Access control - routes based on input type:
     * - DbAccessUpdate[]: accessAll
     * - (string, DbAccessInput): accessOne
     * - (FilterData, DbAccessInput): accessAny
     */
    async access<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        updates: DbAccessUpdate[]
    ): Promise<DbRecord<T>[]>;
    async access<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        recordId: string,
        changes: DbAccessInput
    ): Promise<DbRecord<T>>;
    async access<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        filter: FilterData,
        changes: DbAccessInput
    ): Promise<DbRecord<T>[]>;
    async access<T extends Record<string, any> = Record<string, any>>(
        modelName: ModelName,
        first: DbAccessUpdate[] | string | FilterData,
        second?: DbAccessInput
    ): Promise<DbRecord<T> | DbRecord<T>[]> {
        if (Array.isArray(first)) {
            return this.accessAll<T>(modelName, first);
        }
        if (typeof first === 'string') {
            return this.accessOne<T>(modelName, first, second!);
        }
        return this.accessAny<T>(modelName, first, second!);
    }
}
