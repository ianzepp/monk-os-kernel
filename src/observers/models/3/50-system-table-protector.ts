/**
 * System Table Protector - Ring 3 Business Logic
 *
 * Prevents creation of models that would conflict with PostgreSQL system tables
 * or other critical system namespaces (pg_*, information_schema, etc.)
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import type { ModelRecord } from '@src/lib/model-record.js';

// System tables and models that are protected
const SYSTEM_TABLES = new Set([
    'pg_catalog',
    'information_schema',
    'pg_toast',
    'pg_temp',
    'pg_temp_1',
    'public'
]);

export default class SystemTableProtector extends BaseObserver {
    readonly ring = ObserverRing.Business;  // Ring 3
    readonly operations = ['create'] as const;
    readonly models = ['models'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const { model_name } = record;

        if (!model_name) {
            return; // Required field validation handled elsewhere
        }

        // Check against known PostgreSQL system tables
        if (SYSTEM_TABLES.has(model_name)) {
            throw new ValidationError(
                `Cannot create model '${model_name}': conflicts with PostgreSQL system model`,
                'model_name'
            );
        }

        // Check if model already exists in this namespace by querying the models table
        // This automatically respects search_path (set by transaction) and only sees
        // models in the current tenant's namespace
        const result = await SqlUtils.getPool(system).query(
            `SELECT model_name FROM models WHERE model_name = $1 LIMIT 1`,
            [model_name]
        );

        if (result.rows.length > 0) {
            throw new ValidationError(
                `Cannot create model '${model_name}': model already exists`,
                'model_name'
            );
        }
    }
}
