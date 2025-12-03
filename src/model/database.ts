/**
 * DatabaseService - High-level CRUD operations with observer pipeline
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The DatabaseService provides high-level CRUD operations for entity metadata.
 * All mutations (create, update, delete, revert, expire) flow through the
 * observer pipeline, while reads bypass it for performance.
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
 * - stream*  - async generators (bypass pipeline)
 *
 * INVARIANTS
 * ==========
 * INV-1: All database access goes through DatabaseConnection (HAL boundary)
 * INV-2: All mutations go through observer pipeline (unless model.passthrough)
 * INV-3: Reads bypass observer pipeline for performance
 * INV-4: System fields (id, created_at, updated_at) auto-populated
 *
 * @module model/database
 */

import type { DatabaseConnection } from './connection.js';
import type { ModelCache } from './model-cache.js';
import type { Model } from './model.js';
import { ModelRecord } from './model-record.js';
import type { ObserverRunner } from './observers/runner.js';
import type { ObserverContext, SystemContext } from './observers/interfaces.js';
import type { OperationType } from './observers/types.js';
import { EOBSINVALID } from './observers/errors.js';
import { Filter } from './filter.js';
import type {
    FilterData,
    SelectOptions,
    CreateInput,
    UpdateInput,
    DeleteInput,
    RevertInput,
} from './filter-types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Base record with system fields.
 */
export interface DbRecord {
    /** UUID primary key */
    id: string;

    /** Creation timestamp (ISO 8601) */
    created_at: string;

    /** Last modification timestamp (ISO 8601) */
    updated_at: string;

    /** Soft delete timestamp (null = active) */
    trashed_at: string | null;

    /** Hard delete timestamp (null = not purged) */
    expired_at: string | null;

    /** Dynamic fields based on model definition */
    [key: string]: unknown;
}

/**
 * System context for observer pipeline.
 */
export interface ModelSystemContext extends SystemContext {
    /** Database connection (HAL-based) */
    db: DatabaseConnection;

    /** Model metadata cache */
    cache: ModelCache;

    /** Observer runner */
    runner: ObserverRunner;
}

// =============================================================================
// DATABASE SERVICE
// =============================================================================

/**
 * High-level CRUD service with observer pipeline integration.
 */
export class DatabaseService {
    // =========================================================================
    // STATE
    // =========================================================================

    private readonly system: ModelSystemContext;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    constructor(db: DatabaseConnection, cache: ModelCache, runner: ObserverRunner) {
        this.system = { db, cache, runner };
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
        const filter = Filter.from(modelName, filterData, options);
        const { sql, params } = filter.toSQL();
        return this.system.db.query<T>(sql, params);
    }

    /**
     * Select first record matching filter criteria.
     */
    async selectOne<T extends DbRecord>(
        modelName: string,
        filterData: FilterData,
        options: SelectOptions = {}
    ): Promise<T | null> {
        const results = await this.selectAny<T>(
            modelName,
            { ...filterData, limit: 1 },
            options
        );
        return results[0] ?? null;
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
        if (ids.length === 0) return [];
        return this.selectAny<T>(modelName, { where: { id: { $in: ids } } }, options);
    }

    /**
     * Re-select records (refresh from database by their IDs).
     */
    async selectAll<T extends DbRecord>(
        modelName: string,
        records: T[]
    ): Promise<T[]> {
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
        const filter = Filter.from(modelName, filterData, options);
        const { sql, params } = filter.toCountSQL();
        const result = await this.system.db.queryOne<{ count: number }>(sql, params);
        return result?.count ?? 0;
    }

    // =========================================================================
    // STREAM OPERATIONS (bypass observer pipeline)
    // =========================================================================

    /**
     * Stream records matching filter criteria.
     */
    async *streamAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData = {},
        options: SelectOptions = {}
    ): AsyncGenerator<T, void, unknown> {
        const records = await this.selectAny<T>(modelName, filterData, options);
        for (const record of records) {
            yield record;
        }
    }

    /**
     * Stream records by IDs.
     */
    async *streamIds<T extends DbRecord>(
        modelName: string,
        ids: string[],
        options: SelectOptions = {}
    ): AsyncGenerator<T, void, unknown> {
        const records = await this.selectIds<T>(modelName, ids, options);
        for (const record of records) {
            yield record;
        }
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
        const results: T[] = [];
        for (const data of records) {
            const result = await this.createOne<T>(modelName, data);
            results.push(result);
        }
        return results;
    }

    /**
     * Create a single record.
     */
    async createOne<T extends DbRecord>(
        modelName: string,
        data: CreateInput<T>
    ): Promise<T> {
        const model = await this.system.cache.require(modelName);
        const record = new ModelRecord({}, data as Record<string, unknown>);

        // Generate ID if not provided
        if (!record.get('id')) {
            record.set('id', this.generateId());
        }

        // Set timestamps
        const now = new Date().toISOString();
        record.set('created_at', now);
        record.set('updated_at', now);

        // Run observer pipeline
        const context = this.createContext('create', model, record);
        if (!model.isPassthrough) {
            await this.system.runner.run(context);
        }

        // Execute SQL
        await this.executeInsert(modelName, record);

        // Return created record
        const id = record.get('id') as string;
        return (await this.selectOne<T>(modelName, { where: { id } }, { trashed: 'include' }))!;
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
        const results: T[] = [];
        for (const update of updates) {
            const result = await this.updateOne<T>(
                modelName,
                update.id,
                update.changes as Partial<T>
            );
            results.push(result);
        }
        return results;
    }

    /**
     * Update a single record by ID.
     */
    async updateOne<T extends DbRecord>(
        modelName: string,
        id: string,
        changes: Partial<T>
    ): Promise<T> {
        const model = await this.system.cache.require(modelName);

        // Load existing
        const existing = await this.selectOne<T>(modelName, { where: { id } }, { trashed: 'include' });
        if (!existing) {
            throw new Error(`Record ${id} not found in ${modelName}`);
        }

        const record = new ModelRecord(existing as Record<string, unknown>, changes as Record<string, unknown>);
        record.set('updated_at', new Date().toISOString());

        // Run observer pipeline
        const context = this.createContext('update', model, record);
        if (!model.isPassthrough) {
            await this.system.runner.run(context);
        }

        // Execute SQL
        await this.executeUpdate(modelName, id, record);

        return (await this.selectOne<T>(modelName, { where: { id } }, { trashed: 'include' }))!;
    }

    /**
     * Update records by IDs with same changes.
     */
    async updateIds<T extends DbRecord>(
        modelName: string,
        ids: string[],
        changes: Partial<T>
    ): Promise<T[]> {
        const results: T[] = [];
        for (const id of ids) {
            const result = await this.updateOne<T>(modelName, id, changes);
            results.push(result);
        }
        return results;
    }

    /**
     * Update records matching filter with same changes.
     */
    async updateAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData,
        changes: Partial<T>
    ): Promise<T[]> {
        const records = await this.selectAny<T>(modelName, filterData);
        return this.updateIds<T>(
            modelName,
            records.map((r) => r.id),
            changes
        );
    }

    /**
     * Update first matching record or throw if not found.
     */
    async update404<T extends DbRecord>(
        modelName: string,
        filterData: FilterData,
        changes: Partial<T>,
        message?: string
    ): Promise<T> {
        const existing = await this.selectOne<T>(modelName, filterData);
        if (!existing) {
            throw new Error(message || `Record not found in ${modelName}`);
        }
        return this.updateOne<T>(modelName, existing.id, changes);
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
        const results: T[] = [];
        for (const del of deletes) {
            const result = await this.deleteOne<T>(modelName, del.id);
            results.push(result);
        }
        return results;
    }

    /**
     * Soft delete a single record.
     */
    async deleteOne<T extends DbRecord>(modelName: string, id: string): Promise<T> {
        const model = await this.system.cache.require(modelName);

        // Load existing
        const existing = await this.selectOne<T>(modelName, { where: { id } });
        if (!existing) {
            throw new Error(`Record ${id} not found in ${modelName}`);
        }

        const record = new ModelRecord(existing as Record<string, unknown>, {
            trashed_at: new Date().toISOString(),
        });

        // Run observer pipeline
        const context = this.createContext('delete', model, record);
        if (!model.isPassthrough) {
            await this.system.runner.run(context);
        }

        // Execute SQL
        await this.executeUpdate(modelName, id, record);

        return existing;
    }

    /**
     * Soft delete records by IDs.
     */
    async deleteIds<T extends DbRecord>(modelName: string, ids: string[]): Promise<T[]> {
        return this.deleteAll<T>(
            modelName,
            ids.map((id) => ({ id }))
        );
    }

    /**
     * Soft delete records matching filter.
     */
    async deleteAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData
    ): Promise<T[]> {
        const records = await this.selectAny<T>(modelName, filterData);
        return this.deleteIds<T>(
            modelName,
            records.map((r) => r.id)
        );
    }

    /**
     * Soft delete first matching record or throw if not found.
     */
    async delete404<T extends DbRecord>(
        modelName: string,
        filterData: FilterData,
        message?: string
    ): Promise<T> {
        const existing = await this.selectOne<T>(modelName, filterData);
        if (!existing) {
            throw new Error(message || `Record not found in ${modelName}`);
        }
        return this.deleteOne<T>(modelName, existing.id);
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
        const results: T[] = [];
        for (const rev of reverts) {
            const result = await this.revertOne<T>(modelName, rev.id);
            results.push(result);
        }
        return results;
    }

    /**
     * Revert (undelete) a single record.
     */
    async revertOne<T extends DbRecord>(modelName: string, id: string): Promise<T> {
        const model = await this.system.cache.require(modelName);

        // Load existing (must be trashed)
        const existing = await this.selectOne<T>(modelName, { where: { id } }, { trashed: 'only' });
        if (!existing) {
            throw new Error(`Trashed record ${id} not found in ${modelName}`);
        }

        const record = new ModelRecord(existing as Record<string, unknown>, {
            trashed_at: null,
            updated_at: new Date().toISOString(),
        });

        // Run observer pipeline (using 'update' operation for revert)
        const context = this.createContext('update', model, record);
        if (!model.isPassthrough) {
            await this.system.runner.run(context);
        }

        // Execute SQL
        await this.executeUpdate(modelName, id, record);

        return (await this.selectOne<T>(modelName, { where: { id } }))!;
    }

    /**
     * Revert records matching filter.
     */
    async revertAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData = {}
    ): Promise<T[]> {
        const records = await this.selectAny<T>(modelName, filterData, { trashed: 'only' });
        return this.revertAll<T>(
            modelName,
            records.map((r) => ({ id: r.id }))
        );
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
        const results: T[] = [];
        for (const exp of expires) {
            const result = await this.expireOne<T>(modelName, exp.id);
            results.push(result);
        }
        return results;
    }

    /**
     * Hard delete a single record (permanent).
     */
    async expireOne<T extends DbRecord>(modelName: string, id: string): Promise<T> {
        const model = await this.system.cache.require(modelName);

        // Load existing (include trashed)
        const existing = await this.selectOne<T>(modelName, { where: { id } }, { trashed: 'include' });
        if (!existing) {
            throw new Error(`Record ${id} not found in ${modelName}`);
        }

        const record = new ModelRecord(existing as Record<string, unknown>, {
            expired_at: new Date().toISOString(),
        });

        // Run observer pipeline (using 'delete' operation for expire)
        const context = this.createContext('delete', model, record);
        if (!model.isPassthrough) {
            await this.system.runner.run(context);
        }

        // Execute actual DELETE
        const sql = `DELETE FROM ${modelName} WHERE id = ?`;
        await this.system.db.execute(sql, [id]);

        return existing;
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
        const results: T[] = [];
        for (const data of records) {
            const result = await this.upsertOne<T>(modelName, data);
            results.push(result);
        }
        return results;
    }

    /**
     * Upsert a single record (create or update based on id presence).
     */
    async upsertOne<T extends DbRecord>(
        modelName: string,
        data: CreateInput<T> | UpdateInput<T>
    ): Promise<T> {
        // Check if it's an UpdateInput (has id and changes)
        if ('id' in data && 'changes' in data) {
            const updateData = data as UpdateInput<T>;
            return this.updateOne<T>(modelName, updateData.id, updateData.changes);
        }

        // Check if CreateInput has an id
        const createData = data as CreateInput<T> & { id?: string };
        if (createData.id) {
            // Check if record exists
            const existing = await this.selectOne<T>(
                modelName,
                { where: { id: createData.id } },
                { trashed: 'include' }
            );
            if (existing) {
                // Update existing
                const { id, ...changes } = createData;
                return this.updateOne<T>(modelName, id, changes as Partial<T>);
            }
        }

        // Create new
        return this.createOne<T>(modelName, data as CreateInput<T>);
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Generate UUID without dashes (32 chars).
     */
    private generateId(): string {
        return crypto.randomUUID().replace(/-/g, '');
    }

    /**
     * Create observer context for a mutation.
     */
    private createContext(
        operation: OperationType,
        model: Model,
        record: ModelRecord,
        recordIndex: number = 0
    ): ObserverContext {
        return {
            system: this.system,
            operation,
            model: model as unknown as import('./observers/interfaces.js').Model,
            record: record as unknown as import('./observers/interfaces.js').ModelRecord,
            recordIndex,
            errors: [] as EOBSINVALID[],
            warnings: [] as string[],
        };
    }

    /**
     * Execute INSERT statement.
     */
    private async executeInsert(modelName: string, record: ModelRecord): Promise<void> {
        const data = record.toRecord();
        const columns = Object.keys(data);
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map((col) => data[col]);

        const sql = `INSERT INTO ${modelName} (${columns.join(', ')}) VALUES (${placeholders})`;
        await this.system.db.execute(sql, values);
    }

    /**
     * Execute UPDATE statement.
     */
    private async executeUpdate(
        modelName: string,
        id: string,
        record: ModelRecord
    ): Promise<void> {
        const changes = record.toChanges();
        const setClauses: string[] = [];
        const values: unknown[] = [];

        for (const [col, value] of Object.entries(changes)) {
            setClauses.push(`${col} = ?`);
            values.push(value);
        }

        if (setClauses.length === 0) return;

        values.push(id);
        const sql = `UPDATE ${modelName} SET ${setClauses.join(', ')} WHERE id = ?`;
        await this.system.db.execute(sql, values);
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    getSystemContext(): ModelSystemContext {
        return this.system;
    }

    getConnection(): DatabaseConnection {
        return this.system.db;
    }

    getCache(): ModelCache {
        return this.system.cache;
    }

    getRunner(): ObserverRunner {
        return this.system.runner;
    }
}
