/**
 * DDL Create Observer (SQLite) - Ring 6 PostDatabase
 *
 * Executes CREATE TABLE DDL for SQLite after model record is created in ring 5.
 * Uses TEXT for UUIDs, JSON arrays stored as TEXT, INTEGER for booleans.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SQLITE_SYSTEM_COLUMNS } from '@src/lib/database/type-mappings.js';

export default class ModelDdlCreateSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['create'] as const;
    readonly adapters = ['sqlite'] as const;
    readonly models = ['models'] as const;
    readonly priority = 10;  // Same priority as PostgreSQL version

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const { model_name, external } = record;

        // Skip DDL operations for external models (managed elsewhere)
        if (external === true) {
            console.info(`Skipping DDL operation for external model: ${model_name}`);
            return;
        }

        try {
            const ddl = `CREATE TABLE "${model_name}" (\n${SQLITE_SYSTEM_COLUMNS}\n);`;

            console.info('Executing SQLite DDL:', ddl);

            await system.adapter!.query(ddl);
            console.info(`Created SQLite table for model: ${model_name}`);
        } catch (error) {
            throw new SystemError(
                `Failed to create SQLite table for model '${model_name}': ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
