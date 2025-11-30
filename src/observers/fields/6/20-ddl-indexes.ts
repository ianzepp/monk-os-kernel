/**
 * DDL Indexes Observer - Ring 6 PostDatabase
 *
 * Manages index creation/deletion based on index, unique, and searchable flags.
 * Runs after field DDL operations to create/drop indexes as needed.
 *
 * Priority 20 (after field DDL at priority 10) to ensure field exists first.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import { isSystemField } from '@src/lib/describe.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class DdlIndexesObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['create', 'update', 'delete'] as const;
    readonly adapters = ['postgresql'] as const;  // PostgreSQL CREATE INDEX
    readonly models = ['fields'] as const;
    readonly priority = 20;  // After field DDL (priority 10)

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

        // Skip system fields - they cannot have user-defined indexes
        if (isSystemField(field_name)) {
            return;
        }

        const operation = context.operation;

        if (operation === 'create') {
            await this.handleCreate(record, system, model_name, field_name);
        } else if (operation === 'update') {
            await this.handleUpdate(record, context, system, model_name, field_name);
        } else if (operation === 'delete') {
            await this.handleDelete(record, system, model_name, field_name);
        }
    }

    /**
     * Create indexes on field creation if flags are set
     */
    private async handleCreate(record: any, system: any, model_name: string, field_name: string): Promise<void> {
        const pool = SqlUtils.getPool(system);

        // Create unique index if unique flag is set
        if (record.unique === true) {
            const indexName = `${model_name}_${field_name}_unique_idx`;
            const ddl = `CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${model_name}" ("${field_name}")`;

            try {
                await pool.query(ddl);
                console.info(`Created unique index: ${indexName}`);
            } catch (error) {
                throw new SystemError(
                    `Failed to create unique index on ${model_name}.${field_name}: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }

        // Create standard index if index flag is set
        if (record.index === true) {
            const indexName = `${model_name}_${field_name}_idx`;
            const ddl = `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${model_name}" ("${field_name}")`;

            try {
                await pool.query(ddl);
                console.info(`Created index: ${indexName}`);
            } catch (error) {
                throw new SystemError(
                    `Failed to create index on ${model_name}.${field_name}: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }

        // Create full-text search index if searchable flag is set
        if (record.searchable === true) {
            const indexName = `${model_name}_${field_name}_search_idx`;
            const ddl = `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${model_name}" USING GIN (to_tsvector('english', "${field_name}"))`;

            try {
                await pool.query(ddl);
                console.info(`Created full-text search index: ${indexName}`);
            } catch (error) {
                throw new SystemError(
                    `Failed to create search index on ${model_name}.${field_name}: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
    }

    /**
     * Update indexes when flags change
     */
    private async handleUpdate(record: any, context: ObserverContext, system: any, model_name: string, field_name: string): Promise<void> {
        const pool = SqlUtils.getPool(system);

        // Handle unique index changes using ModelRecord's change tracking
        await this.handleIndexChange(
            pool,
            model_name,
            field_name,
            'unique',
            Boolean(record.getOriginal('unique')),
            Boolean(record.get('unique')),
            `${model_name}_${field_name}_unique_idx`,
            `CREATE UNIQUE INDEX IF NOT EXISTS "${model_name}_${field_name}_unique_idx" ON "${model_name}" ("${field_name}")`
        );

        // Handle standard index changes
        await this.handleIndexChange(
            pool,
            model_name,
            field_name,
            'index',
            Boolean(record.getOriginal('index')),
            Boolean(record.get('index')),
            `${model_name}_${field_name}_idx`,
            `CREATE INDEX IF NOT EXISTS "${model_name}_${field_name}_idx" ON "${model_name}" ("${field_name}")`
        );

        // Handle searchable index changes
        await this.handleIndexChange(
            pool,
            model_name,
            field_name,
            'searchable',
            Boolean(record.getOriginal('searchable')),
            Boolean(record.get('searchable')),
            `${model_name}_${field_name}_search_idx`,
            `CREATE INDEX IF NOT EXISTS "${model_name}_${field_name}_search_idx" ON "${model_name}" USING GIN (to_tsvector('english', "${field_name}"))`
        );
    }

    /**
     * Helper to handle index creation/deletion on flag change
     */
    private async handleIndexChange(
        pool: any,
        model_name: string,
        field_name: string,
        flagName: string,
        oldValue: boolean,
        newValue: boolean,
        indexName: string,
        createDdl: string
    ): Promise<void> {
        if (oldValue === newValue) {
            return; // No change
        }

        try {
            if (newValue === true) {
                // Flag changed from false to true - create index
                await pool.query(createDdl);
                console.info(`Created ${flagName} index: ${indexName}`);
            } else {
                // Flag changed from true to false - drop index
                const dropDdl = `DROP INDEX IF EXISTS "${indexName}"`;
                await pool.query(dropDdl);
                console.info(`Dropped ${flagName} index: ${indexName}`);
            }
        } catch (error) {
            throw new SystemError(
                `Failed to ${newValue ? 'create' : 'drop'} ${flagName} index on ${model_name}.${field_name}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Drop indexes when field is deleted
     * Note: DROP COLUMN should cascade to indexes, but we explicitly drop for clarity
     */
    private async handleDelete(record: any, system: any, model_name: string, field_name: string): Promise<void> {
        const pool = SqlUtils.getPool(system);

        // Drop all possible indexes for this field
        const indexNames = [
            `${model_name}_${field_name}_unique_idx`,
            `${model_name}_${field_name}_idx`,
            `${model_name}_${field_name}_search_idx`
        ];

        for (const indexName of indexNames) {
            try {
                const ddl = `DROP INDEX IF EXISTS "${indexName}"`;
                await pool.query(ddl);
                console.debug(`Dropped index if exists: ${indexName}`);
            } catch (error) {
                // Log but don't throw - index might not exist
                console.warn(`Could not drop index ${indexName}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}
