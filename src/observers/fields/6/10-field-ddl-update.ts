/**
 * DDL Update Observer - Ring 6 PostDatabase
 *
 * Executes ALTER TABLE ALTER COLUMN DDL after field record is updated in ring 5.
 * Handles type changes, required/NOT NULL changes, and default value changes.
 *
 * Uses ModelRecord's change tracking (changed(), get(), getOriginal()) to detect
 * what DDL operations are needed.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import { isSystemField } from '@src/lib/describe.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class FieldDdlUpdateObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['update'] as const;
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

        // Skip system fields - they cannot be altered
        if (isSystemField(field_name)) {
            console.warn(`Skipping DDL for system field: ${field_name}`);
            return;
        }

        const ddlCommands: string[] = [];

        // Handle type change using ModelRecord's change tracking
        // Types are already PostgreSQL types (converted by Ring 4 type-mapper)
        if (record.changed('type')) {
            const newPgType = record.get('type');
            ddlCommands.push(`ALTER TABLE "${model_name}" ALTER COLUMN "${field_name}" TYPE ${newPgType}`);
        }

        // Handle required (NOT NULL) change
        if (record.changed('required')) {
            const newRequired = Boolean(record.get('required'));
            if (newRequired) {
                ddlCommands.push(`ALTER TABLE "${model_name}" ALTER COLUMN "${field_name}" SET NOT NULL`);
            } else {
                ddlCommands.push(`ALTER TABLE "${model_name}" ALTER COLUMN "${field_name}" DROP NOT NULL`);
            }
        }

        // Handle default value change
        if (record.changed('default_value')) {
            const newDefault = record.get('default_value');
            if (newDefault === null || newDefault === undefined) {
                // Remove default
                ddlCommands.push(`ALTER TABLE "${model_name}" ALTER COLUMN "${field_name}" DROP DEFAULT`);
            } else {
                // Set new default
                let defaultValue: string;
                if (typeof newDefault === 'string') {
                    const escapedDefault = newDefault.replace(/'/g, "''");
                    defaultValue = `'${escapedDefault}'`;
                } else {
                    defaultValue = String(newDefault);
                }
                ddlCommands.push(`ALTER TABLE "${model_name}" ALTER COLUMN "${field_name}" SET DEFAULT ${defaultValue}`);
            }
        }

        // Execute all DDL commands
        if (ddlCommands.length === 0) {
            console.debug(`No DDL changes needed for field: ${model_name}.${field_name}`);
            return;
        }

        for (const ddl of ddlCommands) {
            try {
                await SqlUtils.getPool(system).query(ddl);
                console.info(`Altered field: ${model_name}.${field_name} - ${ddl}`);
            } catch (error) {
                throw new SystemError(
                    `Failed to alter field '${field_name}' in table '${model_name}': ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
    }
}
