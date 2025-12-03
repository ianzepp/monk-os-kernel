/**
 * DatabaseService - Userspace database operations with array-based API
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * DatabaseService provides the userspace interface for database operations.
 * It wraps DatabaseOps (kernel streaming) with familiar array-based signatures,
 * collecting streaming results at the userspace boundary.
 *
 * LAYERS
 * ======
 * ```
 * ┌─────────────────────────────────────┐
 * │  Userspace: DatabaseService         │  ← Array in, Promise<Array> out
 * ├─────────────────────────────────────┤
 * │  Kernel: DatabaseOps                │  ← Source<T> in, AsyncGenerator out
 * ├─────────────────────────────────────┤
 * │  HAL: DatabaseConnection            │  ← SQL in, rows out
 * └─────────────────────────────────────┘
 * ```
 *
 * API NAMING CONVENTIONS
 * ======================
 * | Suffix   | Input Type     | Description                           |
 * |----------|----------------|---------------------------------------|
 * | *All()   | Record array   | Operates on array of full records     |
 * | *Any()   | FilterData     | Uses filter criteria to find records  |
 * | *Ids()   | UUID array     | Operates on specific record IDs       |
 * | *One()   | Single ID      | Single record operation               |
 * | *404()   | FilterData     | Like *Any but throws if not found     |
 *
 * OPERATIONS
 * ==========
 * - select*  - reads (bypass pipeline)
 * - create*  - creates (through pipeline)
 * - update*  - updates (through pipeline)
 * - delete*  - soft delete (through pipeline)
 * - revert*  - undo soft delete (through pipeline)
 * - expire*  - hard delete (through pipeline)
 * - upsert*  - create or update (through pipeline)
 *
 * @module model/database
 */

import type { DatabaseConnection } from './connection.js';
import type { ModelCache } from './model-cache.js';
import type { ObserverRunner } from './observers/runner.js';
import {
    DatabaseOps,
    collect,
    type DbRecord,
    type ModelSystemContext,
} from './database-ops.js';
import type {
    FilterData,
    SelectOptions,
    CreateInput,
    UpdateInput,
    DeleteInput,
    RevertInput,
} from './filter-types.js';

// =============================================================================
// RE-EXPORTS
// =============================================================================

// Re-export types from database-ops for convenience
export type { DbRecord, ModelSystemContext } from './database-ops.js';
export { collect } from './database-ops.js';

// =============================================================================
// DATABASE SERVICE
// =============================================================================

/**
 * Userspace CRUD service with array-based API.
 *
 * WHY: Shell commands and userspace programs expect array inputs/outputs.
 * This layer collects streaming results from DatabaseOps into arrays.
 */
export class DatabaseService {
    // =========================================================================
    // STATE
    // =========================================================================

    private readonly ops: DatabaseOps;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    constructor(db: DatabaseConnection, cache: ModelCache, runner: ObserverRunner) {
        this.ops = new DatabaseOps(db, cache, runner);
    }

    // =========================================================================
    // SELECT OPERATIONS (bypass observer pipeline)
    // =========================================================================

    /**
     * Select records matching filter criteria.
     */
    async selectAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData = {},
        options: SelectOptions = {}
    ): Promise<T[]> {
        return collect(this.ops.selectAny<T>(modelName, filterData, options));
    }

    /**
     * Select first record matching filter criteria.
     */
    async selectOne<T extends DbRecord>(
        modelName: string,
        filterData: FilterData,
        options: SelectOptions = {}
    ): Promise<T | null> {
        for await (const record of this.ops.selectAny<T>(
            modelName,
            { ...filterData, limit: 1 },
            options
        )) {
            return record;
        }
        return null;
    }

    /**
     * Select first record or throw if not found.
     */
    async select404<T extends DbRecord>(
        modelName: string,
        filterData: FilterData,
        message?: string,
        options: SelectOptions = {}
    ): Promise<T> {
        const result = await this.selectOne<T>(modelName, filterData, options);
        if (!result) {
            throw new Error(message || `Record not found in ${modelName}`);
        }
        return result;
    }

    /**
     * Select records by IDs.
     */
    async selectIds<T extends DbRecord>(
        modelName: string,
        ids: string[],
        options: SelectOptions = {}
    ): Promise<T[]> {
        return collect(this.ops.selectIds<T>(modelName, ids, options));
    }

    /**
     * Re-select records (refresh from database by their IDs).
     */
    async selectAll<T extends DbRecord>(modelName: string, records: T[]): Promise<T[]> {
        const ids = records.map((r) => r.id);
        return this.selectIds<T>(modelName, ids);
    }

    /**
     * Count records matching filter.
     */
    async count(
        modelName: string,
        filterData: FilterData = {},
        options: SelectOptions = {}
    ): Promise<number> {
        let count = 0;
        for await (const _ of this.ops.selectAny(modelName, filterData, options)) {
            count++;
        }
        return count;
    }

    // =========================================================================
    // CREATE OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Create multiple records.
     */
    async createAll<T extends DbRecord>(
        modelName: string,
        records: CreateInput<T>[]
    ): Promise<T[]> {
        return collect(this.ops.createAll<T>(modelName, records));
    }

    /**
     * Create a single record.
     */
    async createOne<T extends DbRecord>(
        modelName: string,
        data: CreateInput<T>
    ): Promise<T> {
        for await (const created of this.ops.createAll<T>(modelName, [data])) {
            return created;
        }
        throw new Error('Create failed');
    }

    // =========================================================================
    // UPDATE OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Update multiple records with individual changes.
     */
    async updateAll<T extends DbRecord>(
        modelName: string,
        updates: UpdateInput<T>[]
    ): Promise<T[]> {
        return collect(this.ops.updateAll<T>(modelName, updates));
    }

    /**
     * Update a single record by ID.
     */
    async updateOne<T extends DbRecord>(
        modelName: string,
        id: string,
        changes: Partial<T>
    ): Promise<T> {
        for await (const updated of this.ops.updateAll<T>(modelName, [{ id, changes }])) {
            return updated;
        }
        throw new Error('Update failed');
    }

    /**
     * Update records by IDs with same changes.
     */
    async updateIds<T extends DbRecord>(
        modelName: string,
        ids: string[],
        changes: Partial<T>
    ): Promise<T[]> {
        return collect(this.ops.updateIds<T>(modelName, ids, changes));
    }

    /**
     * Update records matching filter with same changes.
     */
    async updateAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData,
        changes: Partial<T>
    ): Promise<T[]> {
        return collect(this.ops.updateAny<T>(modelName, filterData, changes));
    }

    /**
     * Update first matching record or throw if not found.
     *
     * RACE CONDITION FIX: The old pattern (selectOne then updateOne) had a TOCTOU
     * bug where the record could be deleted between select and update. Now we
     * perform the update directly and check if any records were affected.
     */
    async update404<T extends DbRecord>(
        modelName: string,
        filterData: FilterData,
        changes: Partial<T>,
        message?: string
    ): Promise<T> {
        // Limit to 1 record and perform update atomically
        const limitedFilter = { ...filterData, limit: 1 };
        const results = await this.updateAny<T>(modelName, limitedFilter, changes);
        const result = results[0];

        if (!result) {
            throw new Error(message || `Record not found in ${modelName}`);
        }
        return result;
    }

    // =========================================================================
    // DELETE OPERATIONS - Soft Delete (through observer pipeline)
    // =========================================================================

    /**
     * Soft delete multiple records.
     */
    async deleteAll<T extends DbRecord>(
        modelName: string,
        deletes: DeleteInput[]
    ): Promise<T[]> {
        return collect(this.ops.deleteAll<T>(modelName, deletes));
    }

    /**
     * Soft delete a single record.
     */
    async deleteOne<T extends DbRecord>(modelName: string, id: string): Promise<T> {
        for await (const deleted of this.ops.deleteAll<T>(modelName, [{ id }])) {
            return deleted;
        }
        throw new Error('Delete failed');
    }

    /**
     * Soft delete records by IDs.
     */
    async deleteIds<T extends DbRecord>(modelName: string, ids: string[]): Promise<T[]> {
        return collect(this.ops.deleteIds<T>(modelName, ids));
    }

    /**
     * Soft delete records matching filter.
     */
    async deleteAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData
    ): Promise<T[]> {
        return collect(this.ops.deleteAny<T>(modelName, filterData));
    }

    /**
     * Soft delete first matching record or throw if not found.
     *
     * RACE CONDITION FIX: The old pattern (selectOne then deleteOne) had a TOCTOU
     * bug where the record could be deleted between select and delete. Now we
     * perform the delete directly and check if any records were affected.
     */
    async delete404<T extends DbRecord>(
        modelName: string,
        filterData: FilterData,
        message?: string
    ): Promise<T> {
        // Limit to 1 record and perform delete atomically
        const limitedFilter = { ...filterData, limit: 1 };
        const results = await this.deleteAny<T>(modelName, limitedFilter);
        const result = results[0];

        if (!result) {
            throw new Error(message || `Record not found in ${modelName}`);
        }
        return result;
    }

    // =========================================================================
    // REVERT OPERATIONS - Undo Soft Delete (through observer pipeline)
    // =========================================================================

    /**
     * Revert (undelete) multiple records.
     */
    async revertAll<T extends DbRecord>(
        modelName: string,
        reverts: RevertInput[]
    ): Promise<T[]> {
        return collect(this.ops.revertAll<T>(modelName, reverts));
    }

    /**
     * Revert (undelete) a single record.
     */
    async revertOne<T extends DbRecord>(modelName: string, id: string): Promise<T> {
        for await (const reverted of this.ops.revertAll<T>(modelName, [{ id }])) {
            return reverted;
        }
        throw new Error('Revert failed');
    }

    /**
     * Revert records matching filter.
     */
    async revertAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData = {}
    ): Promise<T[]> {
        return collect(this.ops.revertAny<T>(modelName, filterData));
    }

    // =========================================================================
    // EXPIRE OPERATIONS - Hard Delete (through observer pipeline)
    // =========================================================================

    /**
     * Hard delete multiple records (permanent).
     */
    async expireAll<T extends DbRecord>(
        modelName: string,
        expires: DeleteInput[]
    ): Promise<T[]> {
        return collect(this.ops.expireAll<T>(modelName, expires));
    }

    /**
     * Hard delete a single record (permanent).
     */
    async expireOne<T extends DbRecord>(modelName: string, id: string): Promise<T> {
        for await (const expired of this.ops.expireAll<T>(modelName, [{ id }])) {
            return expired;
        }
        throw new Error('Expire failed');
    }

    // =========================================================================
    // UPSERT OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Upsert multiple records (create or update based on id presence).
     */
    async upsertAll<T extends DbRecord>(
        modelName: string,
        records: (CreateInput<T> | UpdateInput<T>)[]
    ): Promise<T[]> {
        return collect(this.ops.upsertAll<T>(modelName, records));
    }

    /**
     * Upsert a single record (create or update based on id presence).
     */
    async upsertOne<T extends DbRecord>(
        modelName: string,
        data: CreateInput<T> | UpdateInput<T>
    ): Promise<T> {
        for await (const upserted of this.ops.upsertAll<T>(modelName, [data])) {
            return upserted;
        }
        throw new Error('Upsert failed');
    }

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    /**
     * Get the underlying kernel operations (for pipe composition).
     */
    getOps(): DatabaseOps {
        return this.ops;
    }

    /**
     * Get system context (for testing).
     */
    getSystemContext(): ModelSystemContext {
        return this.ops.getSystemContext();
    }

    /**
     * Get database connection (for testing).
     */
    getConnection(): DatabaseConnection {
        return this.ops.getConnection();
    }

    /**
     * Get model cache (for testing).
     */
    getCache(): ModelCache {
        return this.ops.getCache();
    }

    /**
     * Get observer runner (for testing).
     */
    getRunner(): ObserverRunner {
        return this.ops.getRunner();
    }
}
