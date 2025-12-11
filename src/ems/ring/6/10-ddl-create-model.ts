/**
 * DdlCreateModel Observer - Ring 6 CREATE TABLE
 *
 * Creates a new table when a record is inserted into the 'models' table.
 * Runs in Ring 6 (Post-Database) after the model metadata has been persisted.
 *
 * Uses the DatabaseDialect from context to generate dialect-appropriate DDL:
 * - SQLite: TEXT columns, randomblob() for UUID, datetime() for timestamps
 * - PostgreSQL: TIMESTAMPTZ columns, gen_random_uuid() for UUID
 *
 * @module ems/ring/6/ddl-create-model
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

// =============================================================================
// DDL CREATE MODEL OBSERVER
// =============================================================================

/**
 * Creates database table for new models.
 *
 * When a record is inserted into the 'models' table, this observer creates
 * the corresponding database table with standard columns (id, timestamps).
 */
export class DdlCreateModel extends BaseObserver {
    readonly name = 'DdlCreateModel';
    readonly ring = ObserverRing.PostDatabase;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];
    override readonly models: readonly string[] = ['models'];

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const { dialect } = system;

        const modelName = record.get('model_name') as string;

        if (!modelName) {
            throw new EOBSSYS('Cannot create table: model_name is missing');
        }

        // WHY: Both SQLite and PostgreSQL interpret 'ai.request' as schema.table
        const tableName = modelName.replace(/\./g, '_');

        // Use dialect to generate CREATE TABLE with appropriate types
        const sql = dialect.createTable(tableName);

        try {
            await system.db.exec(sql);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            throw new EOBSSYS(`CREATE TABLE failed for '${modelName}': ${message}`);
        }
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default DdlCreateModel;
