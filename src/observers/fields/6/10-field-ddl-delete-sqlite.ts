/**
 * DDL Delete Observer (SQLite) - Ring 6 PostDatabase
 *
 * Handles field deletion for SQLite. SQLite doesn't support DROP COLUMN directly,
 * so we skip this operation. The column will remain but be unused.
 *
 * Note: Full column removal in SQLite requires recreating the table, which is
 * complex and risky. For most use cases, leaving the column is acceptable.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { isSystemField } from '@src/lib/describe.js';

export default class FieldDdlDeleteSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['delete'] as const;
    readonly adapters = ['sqlite'] as const;
    readonly models = ['fields'] as const;
    readonly priority = 10;

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

        // Skip system fields
        if (isSystemField(field_name)) {
            console.warn(`Skipping DDL for system field: ${field_name}`);
            return;
        }

        // SQLite doesn't support ALTER TABLE DROP COLUMN in older versions
        // Modern SQLite 3.35+ does, but we'll skip for safety
        console.warn(`SQLite: Field '${field_name}' marked as deleted but column remains in table '${model_name}'`);
    }
}
