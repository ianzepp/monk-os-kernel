/**
 * DatabaseOps - Generic SQL streaming operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * DatabaseOps provides generic streaming SQL operations over a DatabaseConnection.
 * It is NOT tied to the EMS observer pipeline - it's a reusable SQL streaming
 * library that can be used for any table.
 *
 * For entity-aware operations with observer pipeline, use EntityOps.
 *
 * STREAMING MODEL
 * ===============
 * All methods accept Source<T> (sync or async iterables) and return
 * AsyncGenerator<T>, enabling natural composition with pipes.
 *
 * LAYERS
 * ======
 * ```
 * ┌─────────────────────────────────────┐
 * │  EntityOps                          │  ← EMS: observer pipeline + entities
 * ├─────────────────────────────────────┤
 * │  DatabaseOps (this module)          │  ← Generic SQL streaming
 * ├─────────────────────────────────────┤
 * │  DatabaseConnection                 │  ← HAL: channel wrapper
 * └─────────────────────────────────────┘
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: All database access goes through DatabaseConnection
 * INV-2: No model/entity awareness - just tables and rows
 * INV-3: No observer pipeline - pure SQL operations
 * INV-4: Records stream one at a time (no batching)
 *
 * @module ems/database-ops
 */

import type { DatabaseConnection } from './connection.js';
import { Filter } from './filter.js';
import type { FilterData, SelectOptions } from './filter-types.js';

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
 * Base record with id field.
 */
export interface DbRecord {
    /** UUID primary key */
    id: string;

    /** Dynamic fields */
    [key: string]: unknown;
}

/**
 * Update input for streaming updates.
 */
export interface UpdateRecord<T> {
    /** Record ID */
    id: string;

    /** Fields to update */
    changes: Partial<T>;
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
 * WHY: Used at API boundaries to materialize streams.
 * Streaming code should prefer async iteration.
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
 * Generic SQL streaming operations.
 *
 * No model awareness, no observer pipeline. Just SQL over DatabaseConnection.
 */
export class DatabaseOps {
    // =========================================================================
    // STATE
    // =========================================================================

    private readonly db: DatabaseConnection;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    constructor(db: DatabaseConnection) {
        this.db = db;
    }

    // =========================================================================
    // RAW SQL OPERATIONS
    // =========================================================================

    /**
     * Execute a SELECT query and stream rows.
     *
     * @param sql - SQL SELECT statement
     * @param params - Query parameters (positional)
     */
    async *query<T = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
    ): AsyncGenerator<T> {
        const rows = await this.db.query<T>(sql, params);

        for (const row of rows) {
            yield row;
        }
    }

    /**
     * Execute an INSERT/UPDATE/DELETE statement.
     *
     * @param sql - SQL statement
     * @param params - Query parameters (positional)
     * @returns Affected row count
     */
    async execute(sql: string, params?: unknown[]): Promise<number> {
        return this.db.execute(sql, params);
    }

    /**
     * Execute raw SQL (multiple statements allowed).
     *
     * @param sql - Raw SQL (may contain multiple statements)
     */
    async exec(sql: string): Promise<void> {
        return this.db.exec(sql);
    }

    // =========================================================================
    // TABLE-ORIENTED SELECT
    // =========================================================================

    /**
     * Stream records from a table matching filter criteria.
     *
     * @param table - Table name
     * @param filterData - Filter criteria
     * @param options - Select options (trashed handling, etc.)
     */
    async *selectFrom<T extends DbRecord>(
        table: string,
        filterData: FilterData = {},
        options: SelectOptions = {},
    ): AsyncGenerator<T> {
        const filter = Filter.from(table, filterData, options);
        const { sql, params } = filter.toSQL();

        yield* this.query<T>(sql, params);
    }

    /**
     * Stream records by IDs.
     *
     * @param table - Table name
     * @param ids - Source of IDs
     * @param options - Select options
     */
    async *selectIds<T extends DbRecord>(
        table: string,
        ids: Source<string>,
        options: SelectOptions = {},
    ): AsyncGenerator<T> {
        const idArray = await collect(normalize(ids));

        if (idArray.length === 0) {
            return;
        }

        yield* this.selectFrom<T>(table, { where: { id: { $in: idArray } } }, options);
    }

    // =========================================================================
    // TABLE-ORIENTED INSERT
    // =========================================================================

    /**
     * Insert records into a table and stream inserted rows.
     *
     * @param table - Table name
     * @param source - Source of records to insert
     */
    async *insertInto<T extends DbRecord>(
        table: string,
        source: Source<T>,
    ): AsyncGenerator<T> {
        for await (const record of normalize(source)) {
            const columns = Object.keys(record);
            const placeholders = columns.map(() => '?').join(', ');
            const values = columns.map(col => record[col]);

            const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;

            await this.db.execute(sql, values);

            yield record;
        }
    }

    // =========================================================================
    // TABLE-ORIENTED UPDATE
    // =========================================================================

    /**
     * Update records in a table and stream updated rows.
     *
     * @param table - Table name
     * @param source - Source of update records (id + changes)
     */
    async *updateIn<T extends DbRecord>(
        table: string,
        source: Source<UpdateRecord<T>>,
    ): AsyncGenerator<T> {
        for await (const update of normalize(source)) {
            const { id, changes } = update;
            const setClauses: string[] = [];
            const values: unknown[] = [];

            for (const [col, value] of Object.entries(changes)) {
                setClauses.push(`${col} = ?`);
                values.push(value);
            }

            if (setClauses.length === 0) {
                continue;
            }

            values.push(id);
            const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = ?`;

            await this.db.execute(sql, values);

            // Re-read to get full record
            for await (const row of this.selectFrom<T>(table, { where: { id }, limit: 1 })) {
                yield row;
            }
        }
    }

    // =========================================================================
    // TABLE-ORIENTED DELETE
    // =========================================================================

    /**
     * Delete records from a table by IDs.
     *
     * @param table - Table name
     * @param ids - Source of IDs to delete
     */
    async *deleteFrom(
        table: string,
        ids: Source<string>,
    ): AsyncGenerator<string> {
        for await (const id of normalize(ids)) {
            const sql = `DELETE FROM ${table} WHERE id = ?`;

            await this.db.execute(sql, [id]);
            yield id;
        }
    }

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    /**
     * Get the underlying database connection.
     */
    getConnection(): DatabaseConnection {
        return this.db;
    }
}
