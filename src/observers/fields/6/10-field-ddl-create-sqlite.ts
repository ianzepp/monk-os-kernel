/**
 * DDL Create Observer (SQLite) - Ring 6 PostDatabase
 *
 * Executes ALTER TABLE ADD COLUMN DDL for SQLite after field record is created.
 * Maps user-facing types to SQLite types (TEXT, INTEGER, REAL).
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { isSystemField } from '@src/lib/describe.js';
import { USER_TO_SQLITE } from '@src/lib/database/type-mappings.js';

export default class FieldDdlCreateSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['create'] as const;
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

        // Skip system fields - they're already defined in the table
        if (isSystemField(field_name)) {
            console.warn(`Skipping DDL for system field: ${field_name}`);
            return;
        }

        // Get user type and map to SQLite type
        // Note: For SQLite, we store the user type in the DB and map at DDL time
        const userType = record.get('type');
        const sqliteType = USER_TO_SQLITE[userType] || 'TEXT';

        // Build field definition
        const isRequired = Boolean(record.get('required'));
        const nullable = isRequired ? ' NOT NULL' : '';

        let defaultValue = '';
        const defaultVal = record.get('default_value');
        if (defaultVal !== undefined && defaultVal !== null) {
            if (typeof defaultVal === 'string') {
                const escapedDefault = defaultVal.replace(/'/g, "''");
                defaultValue = ` DEFAULT '${escapedDefault}'`;
            } else if (typeof defaultVal === 'number') {
                defaultValue = ` DEFAULT ${defaultVal}`;
            } else if (typeof defaultVal === 'boolean') {
                // SQLite uses 0/1 for booleans
                defaultValue = ` DEFAULT ${defaultVal ? 1 : 0}`;
            }
        }

        // Generate ALTER TABLE ADD COLUMN DDL
        const ddl = `ALTER TABLE "${model_name}" ADD COLUMN "${field_name}" ${sqliteType}${nullable}${defaultValue}`;

        try {
            await system.adapter!.query(ddl);
            console.info(`Added SQLite field to table: ${model_name}.${field_name} (${sqliteType})`);
        } catch (error) {
            throw new SystemError(
                `Failed to add field '${field_name}' to SQLite table '${model_name}': ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
