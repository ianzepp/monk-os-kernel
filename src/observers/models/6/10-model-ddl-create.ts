/**
 * DDL Create Observer - Ring 6 PostDatabase
 *
 * Executes CREATE TABLE DDL after model record is created in ring 5.
 * Reads fields from the fields table and generates PostgreSQL table with all fields.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import { isSystemField, SYSTEM_FIELDS } from '@src/lib/describe.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class ModelDdlCreateObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['create'] as const;
    readonly adapters = ['postgresql'] as const;  // Uses PostgreSQL-specific types (UUID, UUID[])
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

        try {
            let ddl = `CREATE TABLE "${model_name}" (\n`;

            // Standard system fields
            ddl += `    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n`;
            ddl += `    "access_read" UUID[] DEFAULT '{}'::UUID[],\n`;
            ddl += `    "access_edit" UUID[] DEFAULT '{}'::UUID[],\n`;
            ddl += `    "access_full" UUID[] DEFAULT '{}'::UUID[],\n`;
            ddl += `    "access_deny" UUID[] DEFAULT '{}'::UUID[],\n`;
            ddl += `    "created_at" TIMESTAMP DEFAULT now() NOT NULL,\n`;
            ddl += `    "updated_at" TIMESTAMP DEFAULT now() NOT NULL,\n`;
            ddl += `    "trashed_at" TIMESTAMP,\n`;
            ddl += `    "deleted_at" TIMESTAMP`;
            ddl += `\n);`;

            console.info('Executing DDL:');
            console.info(ddl);

            // Execute DDL
            await SqlUtils.getPool(system).query(ddl);
            console.info(`Created table for model: ${model_name}`);
        } catch (error) {
            throw new SystemError(
                `Failed to create table for model '${model_name}': ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
