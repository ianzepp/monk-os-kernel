/**
 * DdlCreateModelPostgres Observer
 *
 * Creates a new PostgreSQL table when a record is inserted into the 'models' table.
 * Runs in Ring 6 (Post-Database) after the model metadata has been persisted.
 *
 * POSTGRESQL-SPECIFIC DDL
 * =======================
 * - UUID: gen_random_uuid()::text
 * - Timestamps: TIMESTAMPTZ with now() default
 *
 * @module ems/ring/6/ddl-create-model-postgres
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

export class DdlCreateModelPostgres extends BaseObserver {
    readonly name = 'DdlCreateModelPostgres';
    override readonly dialect = 'postgres' as const;
    readonly ring = ObserverRing.PostDatabase;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];
    override readonly models: readonly string[] = ['models'];

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const modelName = record.get('model_name') as string;

        if (!modelName) {
            throw new EOBSSYS('Cannot create table: model_name is missing');
        }

        // WHY: PostgreSQL interprets 'ai.request' as schema.table
        const tableName = modelName.replace(/\./g, '_');

        // WHY TIMESTAMPTZ: Stores timezone-aware timestamps.
        // WHY gen_random_uuid()::text: Generates UUID, casts to text for consistency.
        const sql = `
            CREATE TABLE IF NOT EXISTS ${tableName} (
                id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                created_at  TIMESTAMPTZ DEFAULT now(),
                updated_at  TIMESTAMPTZ DEFAULT now(),
                trashed_at  TIMESTAMPTZ,
                expired_at  TIMESTAMPTZ
            )
        `;

        try {
            await system.db.exec(sql);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new EOBSSYS(`CREATE TABLE failed for '${modelName}': ${message}`);
        }
    }
}

export default DdlCreateModelPostgres;
