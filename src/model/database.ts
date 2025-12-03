/**
 * DatabaseService - High-level CRUD operations with observer pipeline
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The DatabaseService provides high-level CRUD operations for entity metadata.
 * All mutations (create, update, delete) flow through the observer pipeline,
 * while reads bypass it for performance.
 *
 * This is the structured SQL side of the entity+data architecture:
 * - Entity metadata (structured) → DatabaseService → SQLite via HAL
 * - Blob data (raw bytes) → HAL block storage (separate path)
 *
 * OPERATION FLOW
 * ==============
 * ```
 * Read Operations (bypass pipeline):
 * selectOne/selectById → DatabaseConnection.query → SQLite
 *
 * Write Operations (through pipeline):
 * createOne → ObserverRunner.run(context) → Ring 0-9 observers → SQLite
 * ```
 *
 * OBSERVER PIPELINE INTEGRATION
 * =============================
 * The DatabaseService creates ObserverContext for mutations and invokes
 * the ObserverRunner. The actual SQL execution happens in Ring 5 observers
 * (implemented in Phase 4). For now, direct SQL is used as fallback.
 *
 * INVARIANTS
 * ==========
 * INV-1: All database access goes through DatabaseConnection (HAL boundary)
 * INV-2: All mutations go through observer pipeline (unless model.passthrough)
 * INV-3: Reads bypass observer pipeline for performance
 * INV-4: System fields (id, created_at, updated_at) auto-populated
 *
 * CONCURRENCY MODEL
 * =================
 * DatabaseService is stateless - safe for concurrent use. Each mutation
 * creates its own ObserverContext. The underlying DatabaseConnection
 * handles SQLite concurrency (WAL mode).
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

// =============================================================================
// TYPES
// =============================================================================

/**
 * Base record with system fields.
 *
 * WHY: All entity records have these fields. Concrete types extend this.
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
 * Options for select operations.
 */
export interface SelectOptions {
    /** Maximum number of records to return */
    limit?: number;

    /** Number of records to skip */
    offset?: number;

    /** Order by clauses (e.g., ['name ASC', 'created_at DESC']) */
    order?: string[];

    /** Include soft-deleted records */
    includeTrashed?: boolean;
}

/**
 * System context for observer pipeline.
 *
 * WHY explicit type: Provides typed access to system services within observers.
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
 *
 * TESTABILITY:
 * - All dependencies injected via constructor
 * - Direct SQL methods for testing without observers
 * - System context exposed for observer testing
 */
export class DatabaseService {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * System context for observer pipeline.
     *
     * WHY readonly: System services are stable for lifetime of service.
     */
    private readonly system: ModelSystemContext;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a DatabaseService.
     *
     * @param db - DatabaseConnection for HAL-based database access
     * @param cache - ModelCache for model metadata
     * @param runner - ObserverRunner for pipeline execution
     */
    constructor(db: DatabaseConnection, cache: ModelCache, runner: ObserverRunner) {
        this.system = { db, cache, runner };
    }

    // =========================================================================
    // SELECT OPERATIONS (bypass observer pipeline)
    // =========================================================================

    /**
     * Select multiple records.
     *
     * WHY bypass pipeline: Read operations don't need validation/audit.
     * Performance is critical for reads.
     *
     * @param modelName - Model to query (e.g., 'file', 'folder')
     * @param where - Filter conditions (field: value)
     * @param options - Limit, offset, order
     * @returns Array of matching records
     */
    async selectMany<T extends DbRecord>(
        modelName: string,
        where: Record<string, unknown> = {},
        options: SelectOptions = {}
    ): Promise<T[]> {
        // Build WHERE clause
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (!options.includeTrashed) {
            conditions.push('trashed_at IS NULL');
        }

        for (const [key, value] of Object.entries(where)) {
            if (value === null) {
                conditions.push(`${key} IS NULL`);
            } else {
                conditions.push(`${key} = ?`);
                params.push(value);
            }
        }

        // Build SQL
        let sql = `SELECT * FROM ${modelName}`;
        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }
        if (options.order?.length) {
            sql += ` ORDER BY ${options.order.join(', ')}`;
        }
        if (options.limit !== undefined) {
            sql += ` LIMIT ${options.limit}`;
        }
        if (options.offset !== undefined) {
            sql += ` OFFSET ${options.offset}`;
        }

        return this.system.db.query<T>(sql, params);
    }

    /**
     * Select a single record by filter.
     *
     * @param modelName - Model to query
     * @param where - Filter conditions
     * @returns First matching record or null
     */
    async selectOne<T extends DbRecord>(
        modelName: string,
        where: Record<string, unknown>
    ): Promise<T | null> {
        const results = await this.selectMany<T>(modelName, where, { limit: 1 });
        return results[0] ?? null;
    }

    /**
     * Select a single record or throw.
     *
     * WHY: Many operations require a record to exist. This provides
     * a convenient way to assert existence.
     *
     * @param modelName - Model to query
     * @param where - Filter conditions
     * @param message - Optional custom error message
     * @returns Matching record (never null)
     * @throws Error if record not found
     */
    async select404<T extends DbRecord>(
        modelName: string,
        where: Record<string, unknown>,
        message?: string
    ): Promise<T> {
        const result = await this.selectOne<T>(modelName, where);
        if (!result) {
            throw new Error(message || `Record not found in ${modelName}`);
        }
        return result;
    }

    /**
     * Select a record by ID.
     *
     * @param modelName - Model to query
     * @param id - Record UUID
     * @returns Record or null
     */
    async selectById<T extends DbRecord>(modelName: string, id: string): Promise<T | null> {
        return this.selectOne<T>(modelName, { id });
    }

    /**
     * Count records matching filter.
     *
     * @param modelName - Model to count
     * @param where - Filter conditions
     * @param options - Include trashed option
     * @returns Count of matching records
     */
    async count(
        modelName: string,
        where: Record<string, unknown> = {},
        options: Pick<SelectOptions, 'includeTrashed'> = {}
    ): Promise<number> {
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (!options.includeTrashed) {
            conditions.push('trashed_at IS NULL');
        }

        for (const [key, value] of Object.entries(where)) {
            if (value === null) {
                conditions.push(`${key} IS NULL`);
            } else {
                conditions.push(`${key} = ?`);
                params.push(value);
            }
        }

        let sql = `SELECT COUNT(*) as count FROM ${modelName}`;
        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        const result = await this.system.db.queryOne<{ count: number }>(sql, params);
        return result?.count ?? 0;
    }

    // =========================================================================
    // MUTATION OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Create a single record.
     *
     * ALGORITHM:
     * 1. Load model metadata
     * 2. Create ModelRecord (empty original, input as changes)
     * 3. Generate ID and timestamps
     * 4. Run observer pipeline
     * 5. If no Ring 5 observer executed SQL, do direct INSERT
     * 6. Return created record
     *
     * @param modelName - Model to create in
     * @param data - Record data
     * @returns Created record with generated ID and timestamps
     */
    async createOne<T extends DbRecord>(
        modelName: string,
        data: Record<string, unknown>
    ): Promise<T> {
        const model = await this.system.cache.require(modelName);
        const record = new ModelRecord({}, data);

        // Generate ID if not provided
        if (!record.get('id')) {
            record.set('id', this.generateId());
        }

        // Set timestamps
        const now = new Date().toISOString();
        record.set('created_at', now);
        record.set('updated_at', now);

        // Create context and run pipeline
        const context = this.createContext('create', model, record);

        // Check if model bypasses pipeline
        if (!model.isPassthrough) {
            await this.system.runner.run(context);
        }

        // Direct SQL insert (Ring 5 observers will replace this in Phase 4)
        await this.executeInsert(modelName, record);

        // Return the created record
        return (await this.selectById<T>(modelName, record.get('id') as string))!;
    }

    /**
     * Create multiple records.
     *
     * WHY not batch: Each record needs individual validation and tracking.
     * Batching can be added later as optimization if needed.
     *
     * @param modelName - Model to create in
     * @param dataArray - Array of record data
     * @returns Array of created records
     */
    async createMany<T extends DbRecord>(
        modelName: string,
        dataArray: Record<string, unknown>[]
    ): Promise<T[]> {
        const results: T[] = [];
        for (const data of dataArray) {
            const result = await this.createOne<T>(modelName, data);
            results.push(result);
        }
        return results;
    }

    /**
     * Update a single record by ID.
     *
     * ALGORITHM:
     * 1. Load existing record
     * 2. Create ModelRecord (existing as original, changes as input)
     * 3. Update timestamp
     * 4. Run observer pipeline
     * 5. If no Ring 5 observer executed SQL, do direct UPDATE
     * 6. Return updated record
     *
     * @param modelName - Model to update in
     * @param id - Record UUID
     * @param changes - Fields to update
     * @returns Updated record
     * @throws Error if record not found
     */
    async updateOne<T extends DbRecord>(
        modelName: string,
        id: string,
        changes: Record<string, unknown>
    ): Promise<T> {
        const model = await this.system.cache.require(modelName);

        // Load existing record
        const existing = await this.selectById(modelName, id);
        if (!existing) {
            throw new Error(`Record ${id} not found in ${modelName}`);
        }

        const record = new ModelRecord(existing, changes);
        record.set('updated_at', new Date().toISOString());

        // Create context and run pipeline
        const context = this.createContext('update', model, record);

        if (!model.isPassthrough) {
            await this.system.runner.run(context);
        }

        // Direct SQL update (Ring 5 observers will replace this in Phase 4)
        await this.executeUpdate(modelName, id, record);

        return (await this.selectById<T>(modelName, id))!;
    }

    /**
     * Soft delete a record.
     *
     * WHY soft delete: Preserves data for audit, recovery, and compliance.
     * Hard delete can be done via separate purge operation.
     *
     * @param modelName - Model to delete from
     * @param id - Record UUID
     * @returns Record as it was before deletion
     * @throws Error if record not found
     */
    async deleteOne<T extends DbRecord>(modelName: string, id: string): Promise<T> {
        const model = await this.system.cache.require(modelName);

        // Load existing record
        const existing = await this.selectById<T>(modelName, id);
        if (!existing) {
            throw new Error(`Record ${id} not found in ${modelName}`);
        }

        const record = new ModelRecord(existing, {
            trashed_at: new Date().toISOString(),
        });

        // Create context and run pipeline
        const context = this.createContext('delete', model, record);

        if (!model.isPassthrough) {
            await this.system.runner.run(context);
        }

        // Direct SQL update (Ring 5 observers will replace this in Phase 4)
        await this.executeUpdate(modelName, id, record);

        // Return the record as it was before deletion
        return existing;
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Generate a UUID for new records.
     *
     * WHY crypto.randomUUID: Standard, cryptographically secure UUID v4.
     * Format: lowercase hex without dashes (32 chars) to match SQLite schema.
     */
    private generateId(): string {
        return crypto.randomUUID().replace(/-/g, '');
    }

    /**
     * Create observer context for a mutation.
     *
     * @param operation - Operation type
     * @param model - Model being operated on
     * @param record - Record being processed
     * @param recordIndex - Position in batch (0 for single operations)
     * @returns ObserverContext ready for pipeline
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
     *
     * WHY direct SQL: Phase 4 will add Ring 5 observers for SQL execution.
     * This is a fallback/bootstrap implementation.
     *
     * @param modelName - Table name
     * @param record - Record to insert
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
     *
     * @param modelName - Table name
     * @param id - Record ID
     * @param record - Record with changes
     */
    private async executeUpdate(modelName: string, id: string, record: ModelRecord): Promise<void> {
        const changes = record.toChanges();
        const setClauses: string[] = [];
        const values: unknown[] = [];

        for (const [col, value] of Object.entries(changes)) {
            setClauses.push(`${col} = ?`);
            values.push(value);
        }

        if (setClauses.length === 0) {
            return; // Nothing to update
        }

        values.push(id);
        const sql = `UPDATE ${modelName} SET ${setClauses.join(', ')} WHERE id = ?`;
        await this.system.db.execute(sql, values);
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get the system context.
     *
     * TESTING: Allows tests to access system services.
     */
    getSystemContext(): ModelSystemContext {
        return this.system;
    }

    /**
     * Get the database connection.
     *
     * TESTING: Allows tests to run direct SQL.
     */
    getConnection(): DatabaseConnection {
        return this.system.db;
    }

    /**
     * Get the model cache.
     *
     * TESTING: Allows tests to preload/invalidate models.
     */
    getCache(): ModelCache {
        return this.system.cache;
    }

    /**
     * Get the observer runner.
     *
     * TESTING: Allows tests to register/inspect observers.
     */
    getRunner(): ObserverRunner {
        return this.system.runner;
    }
}
