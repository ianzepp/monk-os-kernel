/**
 * EntityOps - Entity-aware streaming operations with observer pipeline
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * EntityOps provides entity-aware database operations that flow through the
 * EMS observer pipeline. It builds on DatabaseOps (generic SQL streaming)
 * and adds:
 *
 * - Model/field metadata via ModelCache
 * - Observer pipeline via ObserverRunner (Rings 0-8)
 * - Dual-table handling (entities + detail tables)
 * - Automatic timestamps (created_at, updated_at, trashed_at)
 * - Soft delete / revert / expire semantics
 *
 * LAYERS
 * ======
 * ```
 * ┌─────────────────────────────────────┐
 * │  EntityAPI (os.ems)                 │  ← Public: array-based
 * ├─────────────────────────────────────┤
 * │  EntityOps (this module)            │  ← Kernel: streaming + observers
 * ├─────────────────────────────────────┤
 * │  DatabaseOps                        │  ← Generic SQL streaming
 * ├─────────────────────────────────────┤
 * │  DatabaseConnection                 │  ← HAL: channel wrapper
 * └─────────────────────────────────────┘
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: All mutations go through observer pipeline (unless model.passthrough)
 * INV-2: Reads bypass observer pipeline for performance
 * INV-3: System fields (id, created_at, updated_at) auto-populated
 * INV-4: Records stream one at a time through pipeline
 *
 * @module ems/entity-ops
 */

import type { DatabaseConnection } from './connection.js';
import { DatabaseOps, collect, type Source, type DbRecord } from './database-ops.js';
import type { ModelCache } from './model-cache.js';
import type { Model } from './model.js';
import { ModelRecord } from './model-record.js';
import type { ObserverRunner } from './observers/runner.js';
import type { ObserverContext, SystemContext } from './observers/interfaces.js';
import type { OperationType } from './observers/types.js';
import type { EOBSINVALID } from './observers/errors.js';
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
// RE-EXPORTS
// =============================================================================

export { collect, type Source } from './database-ops.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Entity record with system fields.
 */
export interface EntityRecord extends DbRecord {
    /** Creation timestamp (ISO 8601) */
    created_at: string;

    /** Last modification timestamp (ISO 8601) */
    updated_at: string;

    /** Soft delete timestamp (null = active) */
    trashed_at: string | null;

    /** Hard delete timestamp (null = not purged) */
    expired_at: string | null;
}

/**
 * System context for observer pipeline.
 */
export interface EntitySystemContext extends SystemContext {
    /** Database connection (HAL-based) */
    db: DatabaseConnection;

    /** Model metadata cache */
    cache: ModelCache;

    /** Observer runner */
    runner: ObserverRunner;

    /** Path cache for path resolution (optional, set by VFS layer) */
    pathCache?: unknown;
}

// =============================================================================
// ENTITY OPS CLASS
// =============================================================================

/**
 * Entity-aware streaming database operations.
 *
 * All mutations flow through the observer pipeline record by record.
 */
export class EntityOps {
    // =========================================================================
    // STATE
    // =========================================================================

    private readonly dbOps: DatabaseOps;
    private readonly system: EntitySystemContext;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    constructor(db: DatabaseConnection, cache: ModelCache, runner: ObserverRunner) {
        this.dbOps = new DatabaseOps(db);
        this.system = { db, cache, runner };
    }

    // =========================================================================
    // SELECT OPERATIONS (bypass observer pipeline)
    // =========================================================================

    /**
     * Stream records matching filter criteria.
     */
    async *selectAny<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData = {},
        options: SelectOptions = {},
    ): AsyncGenerator<T> {
        const filter = Filter.from(modelName, filterData, options);
        const { sql, params } = filter.toSQL();

        yield* this.dbOps.query<T>(sql, params);
    }

    /**
     * Stream records by IDs.
     */
    async *selectIds<T extends EntityRecord>(
        modelName: string,
        ids: Source<string>,
        options: SelectOptions = {},
    ): AsyncGenerator<T> {
        const idArray = await collect(this.normalize(ids));

        if (idArray.length === 0) {
            return;
        }

        yield* this.selectAny<T>(modelName, { where: { id: { $in: idArray } } }, options);
    }

    // =========================================================================
    // CREATE OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Stream created records.
     *
     * Each record flows through the observer pipeline individually.
     */
    async *createAll<T extends EntityRecord>(
        modelName: string,
        source: Source<CreateInput<T>>,
    ): AsyncGenerator<T> {
        const model = await this.system.cache.require(modelName);

        for await (const data of this.normalize(source)) {
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
                // Bypass observer pipeline for passthrough models
                await this.executeInsertDirect(modelName, record);
            }
            else {
                // Full observer pipeline
                const context = this.createContext('create', model, record);

                await this.system.runner.run(context);
            }

            // Add model field (stored in entities table, needed in output)
            record.set('model', modelName);

            // Yield created record directly (no re-read needed)
            yield record.toRecord() as T;
        }
    }

    // =========================================================================
    // UPDATE OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Stream updated records from UpdateInput source.
     */
    async *updateAll<T extends EntityRecord>(
        modelName: string,
        source: Source<UpdateInput<T>>,
    ): AsyncGenerator<T> {
        const model = await this.system.cache.require(modelName);

        for await (const update of this.normalize(source)) {
            const id = update.id;
            const changes = update.changes;

            // Load existing
            let existing: T | null = null;

            for await (const row of this.selectAny<T>(
                modelName,
                { where: { id }, limit: 1 },
                { trashed: 'include' },
            )) {
                existing = row;
                break;
            }

            if (!existing) {
                throw new ENOENT(`Record ${id} not found in ${modelName}`);
            }

            const record = new ModelRecord(
                existing as Record<string, unknown>,
                changes as Record<string, unknown>,
            );

            record.set('updated_at', new Date().toISOString());

            if (model.isPassthrough) {
                await this.executeUpdateDirect(modelName, id, record);
            }
            else {
                const context = this.createContext('update', model, record);

                await this.system.runner.run(context);
            }

            // Yield updated record
            for await (const updated of this.selectAny<T>(
                modelName,
                { where: { id }, limit: 1 },
                { trashed: 'include' },
            )) {
                yield updated;
            }
        }
    }

    /**
     * Stream updated records by IDs with same changes.
     */
    async *updateIds<T extends EntityRecord>(
        modelName: string,
        ids: Source<string>,
        changes: Partial<T>,
    ): AsyncGenerator<T> {
        const self = this;
        const updates = async function* (): AsyncGenerator<UpdateInput<T>> {
            for await (const id of self.normalize(ids)) {
                yield { id, changes };
            }
        };

        yield* this.updateAll<T>(modelName, updates());
    }

    /**
     * Stream updated records matching filter with same changes.
     */
    async *updateAny<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData,
        changes: Partial<T>,
    ): AsyncGenerator<T> {
        const self = this;
        const ids = async function* (): AsyncGenerator<string> {
            for await (const record of self.selectAny<T>(modelName, filterData)) {
                yield record.id;
            }
        };

        yield* this.updateIds<T>(modelName, ids(), changes);
    }

    // =========================================================================
    // DELETE OPERATIONS - Soft Delete (through observer pipeline)
    // =========================================================================

    /**
     * Stream soft-deleted records from DeleteInput source.
     */
    async *deleteAll<T extends EntityRecord>(
        modelName: string,
        source: Source<DeleteInput>,
    ): AsyncGenerator<T> {
        const model = await this.system.cache.require(modelName);

        for await (const del of this.normalize(source)) {
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
                await this.executeUpdateDirect(modelName, id, record);
            }
            else {
                const context = this.createContext('delete', model, record);

                await this.system.runner.run(context);
            }

            yield existing;
        }
    }

    /**
     * Stream soft-deleted records by IDs.
     */
    async *deleteIds<T extends EntityRecord>(
        modelName: string,
        ids: Source<string>,
    ): AsyncGenerator<T> {
        const self = this;
        const deletes = async function* (): AsyncGenerator<DeleteInput> {
            for await (const id of self.normalize(ids)) {
                yield { id };
            }
        };

        yield* this.deleteAll<T>(modelName, deletes());
    }

    /**
     * Stream soft-deleted records matching filter.
     */
    async *deleteAny<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData,
    ): AsyncGenerator<T> {
        const self = this;
        const ids = async function* (): AsyncGenerator<string> {
            for await (const record of self.selectAny<T>(modelName, filterData)) {
                yield record.id;
            }
        };

        yield* this.deleteIds<T>(modelName, ids());
    }

    // =========================================================================
    // REVERT OPERATIONS - Undo Soft Delete (through observer pipeline)
    // =========================================================================

    /**
     * Stream reverted records from RevertInput source.
     */
    async *revertAll<T extends EntityRecord>(
        modelName: string,
        source: Source<RevertInput>,
    ): AsyncGenerator<T> {
        const model = await this.system.cache.require(modelName);

        for await (const rev of this.normalize(source)) {
            const id = rev.id;

            // Load existing (must be trashed)
            let existing: T | null = null;

            for await (const row of this.selectAny<T>(
                modelName,
                { where: { id }, limit: 1 },
                { trashed: 'only' },
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
                await this.executeUpdateDirect(modelName, id, record);
            }
            else {
                const context = this.createContext('update', model, record);

                await this.system.runner.run(context);
            }

            // Yield reverted record
            for await (const reverted of this.selectAny<T>(
                modelName,
                { where: { id }, limit: 1 },
            )) {
                yield reverted;
            }
        }
    }

    /**
     * Stream reverted records matching filter.
     */
    async *revertAny<T extends EntityRecord>(
        modelName: string,
        filterData: FilterData = {},
    ): AsyncGenerator<T> {
        const self = this;
        const ids = async function* (): AsyncGenerator<string> {
            for await (const record of self.selectAny<T>(
                modelName,
                filterData,
                { trashed: 'only' },
            )) {
                yield record.id;
            }
        };

        const reverts = async function* (idSource: AsyncGenerator<string>): AsyncGenerator<RevertInput> {
            for await (const id of idSource) {
                yield { id };
            }
        };

        yield* this.revertAll<T>(modelName, reverts(ids()));
    }

    // =========================================================================
    // EXPIRE OPERATIONS - Hard Delete (through observer pipeline)
    // =========================================================================

    /**
     * Stream expired (hard deleted) records from DeleteInput source.
     */
    async *expireAll<T extends EntityRecord>(
        modelName: string,
        source: Source<DeleteInput>,
    ): AsyncGenerator<T> {
        const model = await this.system.cache.require(modelName);

        for await (const exp of this.normalize(source)) {
            const id = exp.id;

            // Load existing (include trashed)
            let existing: T | null = null;

            for await (const row of this.selectAny<T>(
                modelName,
                { where: { id }, limit: 1 },
                { trashed: 'include' },
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

            // Run observer pipeline
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
     */
    async *upsertAll<T extends EntityRecord>(
        modelName: string,
        source: Source<CreateInput<T> | UpdateInput<T>>,
    ): AsyncGenerator<T> {
        for await (const data of this.normalize(source)) {
            // Check if it's an UpdateInput (has id and changes)
            if ('id' in data && 'changes' in data) {
                const updateData = data as UpdateInput<T>;

                yield* this.updateAll<T>(modelName, [updateData]);
                continue;
            }

            // CreateInput - may or may not have id
            const createData = data as CreateInput<T> & { id?: string };

            if (createData.id) {
                // Try create first, catch unique constraint and update
                try {
                    for await (const created of this.createAll<T>(modelName, [createData])) {
                        yield created;
                    }

                    continue;
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const isUniqueViolation =
                        message.includes('UNIQUE constraint failed') ||
                        message.includes('SQLITE_CONSTRAINT');

                    if (isUniqueViolation) {
                        const { id, ...changes } = createData;

                        yield* this.updateAll<T>(modelName, [
                            { id: id!, changes: changes as Partial<T> },
                        ]);
                        continue;
                    }

                    throw err;
                }
            }

            // No id provided - always create
            yield* this.createAll<T>(modelName, [data as CreateInput<T>]);
        }
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Normalize sync/async iterables to async.
     */
    private async *normalize<T>(source: Source<T>): AsyncGenerator<T> {
        for await (const item of source) {
            yield item;
        }
    }

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
        recordIndex: number = 0,
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
     * Only used for passthrough models.
     */
    private async executeInsertDirect(modelName: string, record: ModelRecord): Promise<void> {
        const data = record.toRecord();
        const columns = Object.keys(data);
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map(col => data[col]);

        const sql = `INSERT INTO ${modelName} (${columns.join(', ')}) VALUES (${placeholders})`;

        await this.system.db.execute(sql, values);
    }

    /**
     * Execute UPDATE statement directly (bypasses observer pipeline).
     * Only used for passthrough models.
     */
    private async executeUpdateDirect(
        modelName: string,
        id: string,
        record: ModelRecord,
    ): Promise<void> {
        const changes = record.toChanges();
        const setClauses: string[] = [];
        const values: unknown[] = [];

        for (const [col, value] of Object.entries(changes)) {
            setClauses.push(`${col} = ?`);
            values.push(value);
        }

        if (setClauses.length === 0) {
            return;
        }

        values.push(id);
        const sql = `UPDATE ${modelName} SET ${setClauses.join(', ')} WHERE id = ?`;

        await this.system.db.execute(sql, values);
    }

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    getSystemContext(): EntitySystemContext {
        return this.system;
    }

    /**
     * Set the path cache for Ring 8 PathCacheSync observer.
     *
     * WHY method not constructor: PathCache may be created after EntityOps,
     * and the circular dependency (EntityOps → PathCache → VFS → EntityOps)
     * makes constructor injection complex.
     *
     * @param pathCache - PathCache instance
     */
    setPathCache(pathCache: unknown): void {
        this.system.pathCache = pathCache;
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

    getDatabaseOps(): DatabaseOps {
        return this.dbOps;
    }
}
