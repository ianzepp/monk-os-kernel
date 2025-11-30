/**
 * DDL Update Observer (SQLite) - Ring 6 PostDatabase
 *
 * Handles field updates for SQLite. SQLite has limited ALTER TABLE support:
 * - Cannot change column type
 * - Cannot add/remove NOT NULL constraint
 * - Cannot change default value
 *
 * For most field updates, we log a warning. The field metadata is updated
 * but the underlying column remains unchanged.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { isSystemField } from '@src/lib/describe.js';

export default class FieldDdlUpdateSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['update'] as const;
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

        // Check what changed
        const typeChanged = record.changed('type');
        const requiredChanged = record.changed('required');
        const defaultChanged = record.changed('default_value');

        if (typeChanged || requiredChanged || defaultChanged) {
            console.warn(`SQLite: Field '${model_name}.${field_name}' metadata updated but column not modified (SQLite limitation)`);
        }

        // SQLite doesn't support ALTER COLUMN, so we just log and continue
        // The field metadata is updated in the fields table, but the actual
        // column definition in the user table remains unchanged
    }
}
