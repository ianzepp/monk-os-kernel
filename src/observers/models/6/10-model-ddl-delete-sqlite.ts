/**
 * DDL Delete Observer (SQLite) - Ring 6 PostDatabase
 *
 * Executes DROP TABLE DDL for SQLite after model record is soft-deleted in ring 5.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';

export default class ModelDdlDeleteSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['delete'] as const;
    readonly adapters = ['sqlite'] as const;
    readonly models = ['models'] as const;
    readonly priority = 10;

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const { model_name, external } = record;

        // Skip DDL operations for external models (managed elsewhere)
        if (external === true) {
            console.info(`Skipping DDL operation for external model: ${model_name}`);
            return;
        }

        const ddl = `DROP TABLE IF EXISTS "${model_name}"`;

        try {
            await system.adapter!.query(ddl);
            console.info(`Dropped SQLite table for model: ${model_name}`);
        } catch (error) {
            throw new SystemError(
                `Failed to drop SQLite table for model '${model_name}': ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
