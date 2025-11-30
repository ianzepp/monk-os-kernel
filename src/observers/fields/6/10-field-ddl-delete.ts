/**
 * DDL Delete Observer - Ring 6 PostDatabase
 *
 * Executes ALTER TABLE DROP COLUMN DDL after field record is soft-deleted in ring 5.
 * This permanently removes the field and all its data from the PostgreSQL table.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import { isSystemField } from '@src/lib/describe.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class FieldDdlDeleteObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['delete'] as const;
    readonly adapters = ['postgresql'] as const;  // PostgreSQL DDL
    readonly models = ['fields'] as const;
    readonly priority = 10;  // High priority - DDL should run before data transformations

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const { model_name, field_name } = record;

        // Load model from namespace cache to check if external
        const model = system.namespace.getModel(model_name);

        // Skip DDL operations for external models (managed elsewhere)
        if (model.external === true) {
            console.info(`Skipping DDL operation for external model field: ${model_name}.${field_name}`);
            return;
        }

        // Skip system fields - they cannot be dropped
        if (isSystemField(field_name)) {
            console.warn(`Skipping DDL for system field: ${field_name}`);
            return;
        }

        // Generate ALTER TABLE DROP COLUMN DDL
        const ddl = `ALTER TABLE "${model_name}" DROP COLUMN IF EXISTS "${field_name}"`;

        // Execute DDL
        try {
            await SqlUtils.getPool(system).query(ddl);
            console.info(`Dropped field from table: ${model_name}.${field_name}`);
        } catch (error) {
            throw new SystemError(
                `Failed to drop field '${field_name}' from table '${model_name}': ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
