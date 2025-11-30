/**
 * DDL Create Observer - Ring 6 PostDatabase
 *
 * Executes ALTER TABLE ADD COLUMN DDL after field record is created in ring 5.
 * Adds the new field to the existing table with appropriate type, constraints, and defaults.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import { isSystemField } from '@src/lib/describe.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class FieldDdlCreateObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['create'] as const;
    readonly adapters = ['postgresql'] as const;  // Uses PostgreSQL-specific types
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

        // Skip system fields - they're already defined in the table
        if (isSystemField(field_name)) {
            console.warn(`Skipping DDL for system field: ${field_name}`);
            return;
        }

        // Type is already PostgreSQL type (converted by Ring 4 type-mapper)
        const pgType = record.type;

        // Build field definition
        const isRequired = Boolean(record.required);
        const nullable = isRequired ? ' NOT NULL' : '';

        let defaultValue = '';
        if (record.default_value !== undefined && record.default_value !== null) {
            if (typeof record.default_value === 'string') {
                const escapedDefault = record.default_value.replace(/'/g, "''");
                defaultValue = ` DEFAULT '${escapedDefault}'`;
            } else if (typeof record.default_value === 'number') {
                defaultValue = ` DEFAULT ${record.default_value}`;
            } else if (typeof record.default_value === 'boolean') {
                defaultValue = ` DEFAULT ${record.default_value}`;
            }
        }

        // Generate ALTER TABLE ADD COLUMN DDL
        const ddl = `ALTER TABLE "${model_name}" ADD COLUMN "${field_name}" ${pgType}${nullable}${defaultValue}`;

        // Execute DDL
        try {
            await SqlUtils.getPool(system).query(ddl);
            console.info(`Added field to table: ${model_name}.${field_name}`);
        } catch (error) {
            throw new SystemError(
                `Failed to add field '${field_name}' to table '${model_name}': ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
