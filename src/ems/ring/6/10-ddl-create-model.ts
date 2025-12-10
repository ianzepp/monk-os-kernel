/**
 * DdlCreateModel Observer - Base Class
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * DdlCreateModelBase is the abstract base for Ring 6 observers that create
 * database tables when a record is inserted into the 'models' table.
 *
 * Dialect-specific implementations (SQLite, PostgreSQL) extend this class
 * and provide the buildCreateTable() method with appropriate DDL syntax.
 *
 * Ring 6 runs AFTER Ring 5 (database), meaning the model record has already
 * been inserted into the 'models' table before this observer runs.
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * DatabaseOps.createAll('models', { model_name: 'invoices', ... })
 *     |
 * Ring 0-4: Validation, transformation
 *     |
 * Ring 5: INSERT INTO models (...) <-- model record now exists
 *     |
 * Ring 6 (this): --> CREATE TABLE IF NOT EXISTS invoices (...)
 *     |
 * Ring 7-9: Audit, cache invalidation
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Only runs for 'create' operation on 'models' table
 * INV-2: Uses CREATE TABLE IF NOT EXISTS (idempotent)
 * INV-3: Creates standard system columns (id, created_at, updated_at, trashed_at, expired_at)
 *
 * @module ems/ring/6/ddl-create-model
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

// =============================================================================
// BASE CLASS
// =============================================================================

/**
 * Abstract base for table creation observers.
 *
 * WHY abstract: The DDL syntax differs between SQLite and PostgreSQL.
 * Subclasses implement buildCreateTable() with dialect-specific SQL.
 *
 * WHY priority 10: DDL should run early in Ring 6 so subsequent observers
 * (like index creation) can operate on the new table.
 */
export abstract class DdlCreateModelBase extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    abstract override readonly name: string;
    abstract override readonly dialect: 'sqlite' | 'postgres';

    readonly ring = ObserverRing.PostDatabase;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];

    /**
     * Only runs for the 'models' table.
     */
    override readonly models: readonly string[] = ['models'];

    // =========================================================================
    // ABSTRACT METHOD
    // =========================================================================

    /**
     * Build the CREATE TABLE statement for this dialect.
     *
     * @param tableName - Table name (model_name with dots replaced by underscores)
     * @returns CREATE TABLE SQL statement
     */
    protected abstract buildCreateTable(tableName: string): string;

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Create table for new model.
     *
     * ALGORITHM:
     * 1. Get model_name from the record being created
     * 2. Build CREATE TABLE statement with system columns (dialect-specific)
     * 3. Execute DDL via system.db.exec()
     *
     * WHY CREATE TABLE IF NOT EXISTS: Idempotent - if table already exists
     * (e.g., from a previous failed transaction that was retried), we don't
     * fail. The table structure is what matters, not whether we created it.
     *
     * @param context - Observer context with record containing model_name
     * @throws EOBSSYS on DDL execution failure
     */
    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;

        const modelName = record.get('model_name') as string;

        if (!modelName) {
            throw new EOBSSYS('Cannot create table: model_name is missing');
        }

        // Convert model name to valid table name
        // WHY: Both SQLite and PostgreSQL interpret 'ai.request' as schema.table
        const tableName = modelName.replace(/\./g, '_');

        // Build CREATE TABLE with system columns (dialect-specific)
        const sql = this.buildCreateTable(tableName);

        try {
            await system.db.exec(sql);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            throw new EOBSSYS(
                `CREATE TABLE failed for '${modelName}': ${message}`,
            );
        }
    }
}

// =============================================================================
// RE-EXPORTS FOR BACKWARDS COMPATIBILITY
// =============================================================================

export { DdlCreateModelSqlite } from './10-ddl-create-model.sqlite.js';
export { DdlCreateModelPostgres } from './10-ddl-create-model.postgres.js';
