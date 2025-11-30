/**
 * DDL Delete Observer - Ring 6 PostDatabase
 *
 * Executes DROP TABLE DDL after model record is soft-deleted in ring 5.
 * This permanently removes the table and all its data from PostgreSQL.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class ModelDdlDeleteObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['delete'] as const;
    readonly adapters = ['postgresql'] as const;  // PostgreSQL DDL
    readonly models = ['models'] as const;
    readonly priority = 10;  // High priority - DDL should run before data transformations

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const { model_name, external } = record;

        // Skip DDL operations for external models (managed elsewhere)
        if (external === true) {
            console.info(`Skipping DDL operation for external model: ${model_name}`);
            return;
        }

        // Generate DROP TABLE DDL
        const ddl = `DROP TABLE IF EXISTS "${model_name}" CASCADE`;

        // Execute DDL
        try {
            await SqlUtils.getPool(system).query(ddl);
            console.info(`Dropped table for model: ${model_name}`);
        } catch (error) {
            throw new SystemError(
                `Failed to drop table for model '${model_name}': ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
