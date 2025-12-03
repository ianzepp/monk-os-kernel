/**
 * DatabaseOps - Kernel-level streaming database operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * DatabaseOps provides the kernel-level streaming interface for database
 * operations. All methods accept Source<T> (sync or async iterables) and
 * return AsyncGenerator<T>, enabling natural composition with MessagePipes.
 *
 * This is the internal kernel API. Userspace code should use DatabaseService,
 * which wraps these methods with familiar array-based signatures.
 *
 * STREAMING MODEL
 * ===============
 * Inside the kernel, everything is AsyncIterable:
 * - Input: Source<T> = Iterable<T> | AsyncIterable<T>
 * - Output: AsyncGenerator<T>
 * - Records flow one at a time through the observer pipeline
 * - Backpressure propagates naturally via async iteration
 *
 * INVARIANTS
 * ==========
 * INV-1: All database access goes through DatabaseConnection (HAL boundary)
 * INV-2: All mutations go through observer pipeline (unless model.passthrough)
 * INV-3: Reads bypass observer pipeline for performance
 * INV-4: System fields (id, created_at, updated_at) auto-populated
 * INV-5: Records stream one at a time (no batching)
 *
 * @module model/database-ops
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
import { ENOENT } from '@src/hal/errors.js';
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
 * Source type - accepts sync or async iterables.
 *
 * WHY: Unifies array input (Iterable) and stream input (AsyncIterable).
 * Arrays are consumed synchronously, pipes/generators asynchronously.
 */
export type Source<T> = Iterable<T> | AsyncIterable<T>;

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
// HELPER FUNCTIONS
// =============================================================================

/**
 * Normalize sync/async iterables to async.
 *
 * WHY: Allows uniform processing regardless of input type.
 * Arrays (Iterable) and pipes (AsyncIterable) are handled the same way.
 */
async function* normalize<T>(source: Source<T>): AsyncGenerator<T> {
    for await (const item of source) {
        yield item;
    }
}

/**
 * Collect an async iterable into an array.
 *
 * WHY: Used at userspace boundary to materialize streams.
 * Kernel code should prefer streaming; this is for compatibility.
 */
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
    const results: T[] = [];
    for await (const item of source) {
        results.push(item);
    }
    return results;
}

// =============================================================================
// DATABASE OPS CLASS
// =============================================================================

/**
 * Kernel-level streaming database operations.
 *
 * All methods are AsyncGenerators that yield records one at a time.
 * Mutations flow through the observer pipeline record by record.
 */
export class DatabaseOps {
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
     * Stream records matching filter criteria.
     */
    async *selectAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData = {},
        options: SelectOptions = {}
    ): AsyncGenerator<T> {
        const filter = Filter.from(modelName, filterData, options);
        const { sql, params } = filter.toSQL();
        const rows = await this.system.db.query<T>(sql, params);
        for (const row of rows) {
            yield row;
        }
    }

    /**
     * Stream records by IDs.
     */
    async *selectIds<T extends DbRecord>(
        modelName: string,
        ids: Source<string>,
        options: SelectOptions = {}
    ): AsyncGenerator<T> {
        // Collect IDs first (needed for IN clause)
        const idArray = await collect(normalize(ids));
        if (idArray.length === 0) return;

        yield* this.selectAny<T>(modelName, { where: { id: { $in: idArray } } }, options);
    }

    // =========================================================================
    // CREATE OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Stream created records.
     *
     * Each record flows through the observer pipeline individually,
     * yielded as it completes.
     *
     * ARCHITECTURE NOTE:
     * SQL execution is handled by Ring 5 observers (SqlCreate) for normal models.
     * Passthrough models bypass the observer pipeline entirely, so we execute
     * SQL directly for them.
     */
    async *createAll<T extends DbRecord>(
        modelName: string,
        source: Source<CreateInput<T>>
    ): AsyncGenerator<T> {
        const model = await this.system.cache.require(modelName);

        for await (const data of normalize(source)) {
            const record = new ModelRecord({}, data as Record<string, unknown>);

            // Generate ID if not provided
            if (!record.get('id')) {
                record.set('id', this.generateId());
            }

            // Set timestamps
            const now = new Date().toISOString();
            record.set('created_at', now);
            record.set('updated_at', now);

            if (model.isPassthrough) {
                // PASSTHROUGH: Bypass all observers, execute SQL directly.
                // WHY: Passthrough is a dangerous performance optimization that
                // skips validation, transformation, and audit. Used for system-level
                // bulk operations only.
                await this.executeInsertDirect(modelName, record);
            } else {
                // NORMAL: Full observer pipeline (Ring 5 handles SQL execution)
                const context = this.createContext('create', model, record);
                await this.system.runner.run(context);
            }

            // Yield created record (re-read from database to get final state)
            const id = record.get('id') as string;
            for await (const created of this.selectAny<T>(
                modelName,
                { where: { id }, limit: 1 },
                { trashed: 'include' }
            )) {
                yield created;
            }
        }
    }

    // =========================================================================
    // UPDATE OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Stream updated records from UpdateInput source.
     *
     * ARCHITECTURE NOTE:
     * SQL execution is handled by Ring 5 observers (SqlUpdate) for normal models.
     * Passthrough models bypass the observer pipeline entirely.
     */
    async *updateAll<T extends DbRecord>(
        modelName: string,
        source: Source<UpdateInput<T>>
    ): AsyncGenerator<T> {
        const model = await this.system.cache.require(modelName);

        for await (const update of normalize(source)) {
            const id = update.id;
            const changes = update.changes;

            // Load existing
            let existing: T | null = null;
            for await (const row of this.selectAny<T>(
                modelName,
                { where: { id }, limit: 1 },
                { trashed: 'include' }
            )) {
                existing = row;
                break;
            }

            if (!existing) {
                throw new ENOENT(`Record ${id} not found in ${modelName}`);
            }

            const record = new ModelRecord(
                existing as Record<string, unknown>,
                changes as Record<string, unknown>
            );
            record.set('updated_at', new Date().toISOString());

            if (model.isPassthrough) {
                // PASSTHROUGH: Bypass all observers, execute SQL directly.
                await this.executeUpdateDirect(modelName, id, record);
            } else {
                // NORMAL: Full observer pipeline (Ring 5 handles SQL execution)
                const context = this.createContext('update', model, record);
                await this.system.runner.run(context);
            }

            // Yield updated record (re-read from database to get final state)
            for await (const updated of this.selectAny<T>(
                modelName,
                { where: { id }, limit: 1 },
                { trashed: 'include' }
            )) {
                yield updated;
            }
        }
    }

    /**
     * Stream updated records by IDs with same changes.
     */
    async *updateIds<T extends DbRecord>(
        modelName: string,
        ids: Source<string>,
        changes: Partial<T>
    ): AsyncGenerator<T> {
        const updates = async function* (): AsyncGenerator<UpdateInput<T>> {
            for await (const id of normalize(ids)) {
                yield { id, changes };
            }
        };
        yield* this.updateAll<T>(modelName, updates());
    }

    /**
     * Stream updated records matching filter with same changes.
     */
    async *updateAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData,
        changes: Partial<T>
    ): AsyncGenerator<T> {
        const ids = async function* (self: DatabaseOps): AsyncGenerator<string> {
            for await (const record of self.selectAny<T>(modelName, filterData)) {
                yield record.id;
            }
        };
        yield* this.updateIds<T>(modelName, ids(this), changes);
    }

    // =========================================================================
    // DELETE OPERATIONS - Soft Delete (through observer pipeline)
    // =========================================================================

    /**
     * Stream soft-deleted records from DeleteInput source.
     *
     * ARCHITECTURE NOTE:
     * SQL execution is handled by Ring 5 observers (SqlDelete) for normal models.
     * Passthrough models bypass the observer pipeline entirely.
     */
    async *deleteAll<T extends DbRecord>(
        modelName: string,
        source: Source<DeleteInput>
    ): AsyncGenerator<T> {
        const model = await this.system.cache.require(modelName);

        for await (const del of normalize(source)) {
            const id = del.id;

            // Load existing
            let existing: T | null = null;
            for await (const row of this.selectAny<T>(modelName, { where: { id }, limit: 1 })) {
                existing = row;
                break;
            }

            if (!existing) {
                throw new ENOENT(`Record ${id} not found in ${modelName}`);
            }

            const record = new ModelRecord(existing as Record<string, unknown>, {
                trashed_at: new Date().toISOString(),
            });

            if (model.isPassthrough) {
                // PASSTHROUGH: Bypass all observers, execute SQL directly.
                await this.executeUpdateDirect(modelName, id, record);
            } else {
                // NORMAL: Full observer pipeline (Ring 5 handles SQL execution)
                const context = this.createContext('delete', model, record);
                await this.system.runner.run(context);
            }

            yield existing;
        }
    }

    /**
     * Stream soft-deleted records by IDs.
     */
    async *deleteIds<T extends DbRecord>(
        modelName: string,
        ids: Source<string>
    ): AsyncGenerator<T> {
        const deletes = async function* (): AsyncGenerator<DeleteInput> {
            for await (const id of normalize(ids)) {
                yield { id };
            }
        };
        yield* this.deleteAll<T>(modelName, deletes());
    }

    /**
     * Stream soft-deleted records matching filter.
     */
    async *deleteAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData
    ): AsyncGenerator<T> {
        const ids = async function* (self: DatabaseOps): AsyncGenerator<string> {
            for await (const record of self.selectAny<T>(modelName, filterData)) {
                yield record.id;
            }
        };
        yield* this.deleteIds<T>(modelName, ids(this));
    }

    // =========================================================================
    // REVERT OPERATIONS - Undo Soft Delete (through observer pipeline)
    // =========================================================================

    /**
     * Stream reverted records from RevertInput source.
     *
     * ARCHITECTURE NOTE:
     * SQL execution is handled by Ring 5 observers (SqlUpdate) for normal models.
     * Revert uses the 'update' operation type since it's modifying trashed_at.
     */
    async *revertAll<T extends DbRecord>(
        modelName: string,
        source: Source<RevertInput>
    ): AsyncGenerator<T> {
        const model = await this.system.cache.require(modelName);

        for await (const rev of normalize(source)) {
            const id = rev.id;

            // Load existing (must be trashed)
            let existing: T | null = null;
            for await (const row of this.selectAny<T>(
                modelName,
                { where: { id }, limit: 1 },
                { trashed: 'only' }
            )) {
                existing = row;
                break;
            }

            if (!existing) {
                throw new ENOENT(`Trashed record ${id} not found in ${modelName}`);
            }

            const record = new ModelRecord(existing as Record<string, unknown>, {
                trashed_at: null,
                updated_at: new Date().toISOString(),
            });

            if (model.isPassthrough) {
                // PASSTHROUGH: Bypass all observers, execute SQL directly.
                await this.executeUpdateDirect(modelName, id, record);
            } else {
                // NORMAL: Full observer pipeline (Ring 5 handles SQL execution)
                const context = this.createContext('update', model, record);
                await this.system.runner.run(context);
            }

            // Yield reverted record (re-read from database to get final state)
            for await (const reverted of this.selectAny<T>(
                modelName,
                { where: { id }, limit: 1 }
            )) {
                yield reverted;
            }
        }
    }

    /**
     * Stream reverted records matching filter.
     */
    async *revertAny<T extends DbRecord>(
        modelName: string,
        filterData: FilterData = {}
    ): AsyncGenerator<T> {
        const ids = async function* (self: DatabaseOps): AsyncGenerator<string> {
            for await (const record of self.selectAny<T>(
                modelName,
                filterData,
                { trashed: 'only' }
            )) {
                yield record.id;
            }
        };

        const reverts = async function* (idSource: AsyncGenerator<string>): AsyncGenerator<RevertInput> {
            for await (const id of idSource) {
                yield { id };
            }
        };

        yield* this.revertAll<T>(modelName, reverts(ids(this)));
    }

    // =========================================================================
    // EXPIRE OPERATIONS - Hard Delete (through observer pipeline)
    // =========================================================================

    /**
     * Stream expired (hard deleted) records from DeleteInput source.
     */
    async *expireAll<T extends DbRecord>(
        modelName: string,
        source: Source<DeleteInput>
    ): AsyncGenerator<T> {
        const model = await this.system.cache.require(modelName);

        for await (const exp of normalize(source)) {
            const id = exp.id;

            // Load existing (include trashed)
            let existing: T | null = null;
            for await (const row of this.selectAny<T>(
                modelName,
                { where: { id }, limit: 1 },
                { trashed: 'include' }
            )) {
                existing = row;
                break;
            }

            if (!existing) {
                throw new ENOENT(`Record ${id} not found in ${modelName}`);
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

            yield existing;
        }
    }

    // =========================================================================
    // UPSERT OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Stream upserted records (create or update based on id presence).
     *
     * RACE CONDITION MITIGATION (TOCTOU):
     * Instead of check-then-act (select exists → create/update), we use
     * try-create-catch-update pattern:
     * 1. If input has id, attempt create first
     * 2. If unique constraint violation, fall back to update
     * 3. This handles concurrent inserts gracefully
     *
     * WHY not INSERT ON CONFLICT: That would bypass the observer pipeline.
     * We want observers to run for both create and update paths.
     */
    async *upsertAll<T extends DbRecord>(
        modelName: string,
        source: Source<CreateInput<T> | UpdateInput<T>>
    ): AsyncGenerator<T> {
        for await (const data of normalize(source)) {
            // Check if it's an UpdateInput (has id and changes)
            if ('id' in data && 'changes' in data) {
                const updateData = data as UpdateInput<T>;
                yield* this.updateAll<T>(modelName, [updateData]);
                continue;
            }

            // CreateInput - may or may not have id
            const createData = data as CreateInput<T> & { id?: string };

            if (createData.id) {
                // RACE FIX: Try create first, catch unique constraint and update
                // This is atomic at the database level and handles concurrent inserts.
                try {
                    for await (const created of this.createAll<T>(modelName, [createData])) {
                        yield created;
                    }
                    continue;
                } catch (err) {
                    // Check for unique constraint violation (SQLite SQLITE_CONSTRAINT)
                    const message = err instanceof Error ? err.message : String(err);
                    const isUniqueViolation =
                        message.includes('UNIQUE constraint failed') ||
                        message.includes('SQLITE_CONSTRAINT');

                    if (isUniqueViolation) {
                        // Record exists - fall back to update
                        const { id, ...changes } = createData;
                        yield* this.updateAll<T>(modelName, [
                            { id: id!, changes: changes as Partial<T> },
                        ]);
                        continue;
                    }

                    // Re-throw non-unique errors
                    throw err;
                }
            }

            // No id provided - always create (will generate new id)
            yield* this.createAll<T>(modelName, [data as CreateInput<T>]);
        }
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
     * Execute INSERT statement directly (bypasses observer pipeline).
     *
     * WHY "Direct": This method is only used for passthrough models that
     * skip the observer pipeline. Normal models use Ring 5 observers
     * (SqlCreate) for SQL execution.
     *
     * SAFETY: Passthrough is a dangerous performance optimization. Only
     * system-level bulk operations should use passthrough models.
     */
    private async executeInsertDirect(modelName: string, record: ModelRecord): Promise<void> {
        const data = record.toRecord();
        const columns = Object.keys(data);
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map((col) => data[col]);

        const sql = `INSERT INTO ${modelName} (${columns.join(', ')}) VALUES (${placeholders})`;
        await this.system.db.execute(sql, values);
    }

    /**
     * Execute UPDATE statement directly (bypasses observer pipeline).
     *
     * WHY "Direct": This method is only used for passthrough models that
     * skip the observer pipeline. Normal models use Ring 5 observers
     * (SqlUpdate, SqlDelete) for SQL execution.
     */
    private async executeUpdateDirect(
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
