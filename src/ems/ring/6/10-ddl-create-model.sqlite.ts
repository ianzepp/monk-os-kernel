/**
 * DdlCreateModelSqlite Observer
 *
 * Creates a new SQLite table when a record is inserted into the 'models' table.
 * Runs in Ring 6 (Post-Database) after the model metadata has been persisted.
 *
 * SQLITE-SPECIFIC DDL
 * ===================
 * - UUID: lower(hex(randomblob(16)))
 * - Timestamps: TEXT with datetime('now') default
 *
 * @module ems/ring/6/ddl-create-model-sqlite
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

export class DdlCreateModelSqlite extends BaseObserver {
    readonly name = 'DdlCreateModelSqlite';
    override readonly dialect = 'sqlite' as const;
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

        // WHY: SQLite interprets 'ai.request' as schema.table
        const tableName = modelName.replace(/\./g, '_');

        // WHY TEXT for timestamps: SQLite has no native datetime type.
        // WHY randomblob: SQLite doesn't have gen_random_uuid().
        const sql = `
            CREATE TABLE IF NOT EXISTS ${tableName} (
                id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                created_at  TEXT DEFAULT (datetime('now')),
                updated_at  TEXT DEFAULT (datetime('now')),
                trashed_at  TEXT,
                expired_at  TEXT
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

export default DdlCreateModelSqlite;
