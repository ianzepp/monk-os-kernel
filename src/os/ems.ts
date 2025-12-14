/**
 * Entity API (os.ems)
 *
 * Provides entity operations for the OS public API.
 * Array-based interface wrapping the kernel's streaming EntityOps.
 *
 * ARCHITECTURE
 * ============
 * ```
 * ┌─────────────────────────────────────┐
 * │  Public: EntityAPI (os.ems)         │  ← Array in, Promise<Array> out
 * ├─────────────────────────────────────┤
 * │  Kernel: EntityOps                  │  ← Source<T> in, AsyncGenerator out
 * ├─────────────────────────────────────┤
 * │  Kernel: DatabaseOps                │  ← Generic SQL streaming
 * ├─────────────────────────────────────┤
 * │  HAL: DatabaseConnection            │  ← Wire protocol (SQLite/Postgres)
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
 */

import type {
    EntityOps } from '@src/ems/entity-ops.js';
import {
    collect,
    type EntityRecord,
} from '@src/ems/entity-ops.js';
import type {
    FilterData,
    SelectOptions,
    CreateInput,
    UpdateInput,
    DeleteInput,
    RevertInput,
} from '@src/ems/index.js';
import { ENOENT, EIO } from '@src/hal/errors.js';

// =============================================================================
// RE-EXPORTS
// =============================================================================

export type { EntityRecord } from '@src/ems/entity-ops.js';
export type {
    FilterData,
    SelectOptions,
    CreateInput,
    UpdateInput,
    DeleteInput,
    RevertInput,
} from '@src/ems/index.js';

// =============================================================================
// HOST INTERFACE
// =============================================================================

/**
 * Interface for OS methods needed by EntityAPI.
 * Avoids circular dependency with OS class.
 */
export interface EntityAPIHost {
    getEntityOps(): EntityOps;
}

// =============================================================================
// ENTITY API
// =============================================================================

/**
 * Entity API for OS (os.ems)
 *
 * Provides CRUD operations with array-based interface.
 * All mutations flow through the observer pipeline.
 */
export class EntityAPI {
    private host: EntityAPIHost;

    constructor(host: EntityAPIHost) {
        this.host = host;
    }

    private get ops(): EntityOps {
        return this.host.getEntityOps();
    }

    // =========================================================================
    // SELECT OPERATIONS (bypass observer pipeline)
    // =========================================================================

    /**
     * Select records matching filter criteria.
     */
    async selectAny<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData = {},
        options: SelectOptions = {},
    ): Promise<T[]> {
        return collect(this.ops.selectAny<T>(modelName, filterData, options));
    }

    /**
     * Select first record matching filter criteria.
     */
    async selectOne<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData,
        options: SelectOptions = {},
    ): Promise<T | null> {
        for await (const record of this.ops.selectAny<T>(
            modelName,
            { ...filterData, limit: 1 },
            options,
        )) {
            return record;
        }

        return null;
    }

    /**
     * Select first record or throw if not found.
     */
    async select404<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData,
        message?: string,
        options: SelectOptions = {},
    ): Promise<T> {
        const result = await this.selectOne<T>(modelName, filterData, options);

        if (!result) {
            throw new ENOENT(message || `Record not found in ${modelName}`);
        }

        return result;
    }

    /**
     * Select records by IDs.
     */
    async selectIds<T extends EntityRecord>(
        modelName: string,
        ids: string[],
        options: SelectOptions = {},
    ): Promise<T[]> {
        return collect(this.ops.selectIds<T>(modelName, ids, options));
    }

    /**
     * Re-select records (refresh from database by their IDs).
     */
    async selectAll<T extends EntityRecord>(modelName: string, records: T[]): Promise<T[]> {
        const ids = records.map(r => r.id);

        return this.selectIds<T>(modelName, ids);
    }

    /**
     * Count records matching filter.
     */
    async count(
        modelName: string,
        filterData: FilterData = {},
        options: SelectOptions = {},
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
    async createAll<T extends EntityRecord>(
        modelName: string,
        records: CreateInput<T>[],
    ): Promise<T[]> {
        return collect(this.ops.createAll<T>(modelName, records));
    }

    /**
     * Create a single record.
     */
    async createOne<T extends EntityRecord>(
        modelName: string,
        data: CreateInput<T>,
    ): Promise<T> {
        for await (const created of this.ops.createAll<T>(modelName, [data])) {
            return created;
        }

        throw new EIO('Create failed');
    }

    // =========================================================================
    // UPDATE OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Update multiple records with individual changes.
     */
    async updateAll<T extends EntityRecord>(
        modelName: string,
        updates: UpdateInput<T>[],
    ): Promise<T[]> {
        return collect(this.ops.updateAll<T>(modelName, updates));
    }

    /**
     * Update a single record by ID.
     */
    async updateOne<T extends EntityRecord>(
        modelName: string,
        id: string,
        changes: Partial<T>,
    ): Promise<T> {
        for await (const updated of this.ops.updateAll<T>(modelName, [{ id, changes }])) {
            return updated;
        }

        throw new EIO('Update failed');
    }

    /**
     * Update records by IDs with same changes.
     */
    async updateIds<T extends EntityRecord>(
        modelName: string,
        ids: string[],
        changes: Partial<T>,
    ): Promise<T[]> {
        return collect(this.ops.updateIds<T>(modelName, ids, changes));
    }

    /**
     * Update records matching filter with same changes.
     */
    async updateAny<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData,
        changes: Partial<T>,
    ): Promise<T[]> {
        return collect(this.ops.updateAny<T>(modelName, filterData, changes));
    }

    /**
     * Update first matching record or throw if not found.
     */
    async update404<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData,
        changes: Partial<T>,
        message?: string,
    ): Promise<T> {
        const limitedFilter = { ...filterData, limit: 1 };
        const results = await this.updateAny<T>(modelName, limitedFilter, changes);
        const result = results[0];

        if (!result) {
            throw new ENOENT(message || `Record not found in ${modelName}`);
        }

        return result;
    }

    // =========================================================================
    // DELETE OPERATIONS - Soft Delete (through observer pipeline)
    // =========================================================================

    /**
     * Soft delete multiple records.
     */
    async deleteAll<T extends EntityRecord>(
        modelName: string,
        deletes: DeleteInput[],
    ): Promise<T[]> {
        return collect(this.ops.deleteAll<T>(modelName, deletes));
    }

    /**
     * Soft delete a single record.
     */
    async deleteOne<T extends EntityRecord>(modelName: string, id: string): Promise<T> {
        for await (const deleted of this.ops.deleteAll<T>(modelName, [{ id }])) {
            return deleted;
        }

        throw new EIO('Delete failed');
    }

    /**
     * Soft delete records by IDs.
     */
    async deleteIds<T extends EntityRecord>(modelName: string, ids: string[]): Promise<T[]> {
        return collect(this.ops.deleteIds<T>(modelName, ids));
    }

    /**
     * Soft delete records matching filter.
     */
    async deleteAny<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData,
    ): Promise<T[]> {
        return collect(this.ops.deleteAny<T>(modelName, filterData));
    }

    /**
     * Soft delete first matching record or throw if not found.
     */
    async delete404<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData,
        message?: string,
    ): Promise<T> {
        const limitedFilter = { ...filterData, limit: 1 };
        const results = await this.deleteAny<T>(modelName, limitedFilter);
        const result = results[0];

        if (!result) {
            throw new ENOENT(message || `Record not found in ${modelName}`);
        }

        return result;
    }

    // =========================================================================
    // REVERT OPERATIONS - Undo Soft Delete (through observer pipeline)
    // =========================================================================

    /**
     * Revert (undelete) multiple records.
     */
    async revertAll<T extends EntityRecord>(
        modelName: string,
        reverts: RevertInput[],
    ): Promise<T[]> {
        return collect(this.ops.revertAll<T>(modelName, reverts));
    }

    /**
     * Revert (undelete) a single record.
     */
    async revertOne<T extends EntityRecord>(modelName: string, id: string): Promise<T> {
        for await (const reverted of this.ops.revertAll<T>(modelName, [{ id }])) {
            return reverted;
        }

        throw new EIO('Revert failed');
    }

    /**
     * Revert records matching filter.
     */
    async revertAny<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData = {},
    ): Promise<T[]> {
        return collect(this.ops.revertAny<T>(modelName, filterData));
    }

    // =========================================================================
    // EXPIRE OPERATIONS - Hard Delete (through observer pipeline)
    // =========================================================================

    /**
     * Hard delete multiple records (permanent).
     */
    async expireAll<T extends EntityRecord>(
        modelName: string,
        expires: DeleteInput[],
    ): Promise<T[]> {
        return collect(this.ops.expireAll<T>(modelName, expires));
    }

    /**
     * Hard delete a single record (permanent).
     */
    async expireOne<T extends EntityRecord>(modelName: string, id: string): Promise<T> {
        for await (const expired of this.ops.expireAll<T>(modelName, [{ id }])) {
            return expired;
        }

        throw new EIO('Expire failed');
    }

    // =========================================================================
    // UPSERT OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Upsert multiple records (create or update based on id presence).
     */
    async upsertAll<T extends EntityRecord>(
        modelName: string,
        records: (CreateInput<T> | UpdateInput<T>)[],
    ): Promise<T[]> {
        return collect(this.ops.upsertAll<T>(modelName, records));
    }

    /**
     * Upsert a single record (create or update based on id presence).
     */
    async upsertOne<T extends EntityRecord>(
        modelName: string,
        data: CreateInput<T> | UpdateInput<T>,
    ): Promise<T> {
        for await (const upserted of this.ops.upsertAll<T>(modelName, [data])) {
            return upserted;
        }

        throw new EIO('Upsert failed');
    }
}
