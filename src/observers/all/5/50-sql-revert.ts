/**
 * SQL Revert Observer - Ring 5 Database Transport Layer
 *
 * Handles REVERT operations - direct SQL execution for undoing soft deletes.
 * Operates on pre-validated trashed records from earlier observer rings.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import { FilterWhere } from '@src/lib/filter-where.js';

export default class SqlRevertObserver extends BaseObserver {
    readonly ring = ObserverRing.Database;
    readonly operations = ['revert'] as const;
    readonly adapters = ['postgresql'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        const id = record.get('id');
        if (!id) {
            throw new SystemError('Revert record must have id field');
        }

        // Use FilterWhere for consistent WHERE clause generation
        const { whereClause, params } = FilterWhere.generate(
            { id },
            0,
            {
                trashed: 'include', // Include trashed records for revert operation
            }
        );

        // Build revert query - only revert actually trashed records
        const fullWhereClause = `${whereClause} AND "trashed_at" IS NOT NULL`;
        const query = `UPDATE "${model.model_name}" SET trashed_at = NULL, updated_at = NOW() WHERE ${fullWhereClause} RETURNING *`;
        const result = await SqlUtils.getPool(system).query(query, params);

        // ExistenceValidator already confirmed this is a trashed record
        if (result.rows.length === 0) {
            throw new SystemError(`Revert operation failed - record not found or not trashed: ${id}`);
        }

        // Update the ModelRecord with final database state
        const dbResult = SqlUtils.convertPostgreSQLTypes(result.rows[0], model);
        record.setCurrent(dbResult);
    }
}
