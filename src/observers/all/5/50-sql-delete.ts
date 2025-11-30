/**
 * SQL Delete Observer - Ring 5 Database Transport Layer
 *
 * Handles DELETE operations - direct SQL execution for soft deleting records.
 * Operates on pre-validated records from earlier observer rings.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import { FilterWhere } from '@src/lib/filter-where.js';

export default class SqlDeleteObserver extends BaseObserver {
    readonly ring = ObserverRing.Database;
    readonly operations = ['delete'] as const;
    readonly adapters = ['postgresql'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        const id = record.get('id');
        if (!id) {
            throw new SystemError('Delete record must have id field');
        }

        // Use FilterWhere for consistent WHERE clause generation
        const { whereClause, params } = FilterWhere.generate({ id });

        const query = `UPDATE "${model.model_name}" SET trashed_at = NOW(), updated_at = NOW() WHERE ${whereClause} RETURNING *`;
        const result = await SqlUtils.getPool(system).query(query, params);

        // Existence validation already confirmed this record exists
        if (result.rows.length === 0) {
            throw new SystemError(`Delete operation failed - record not found: ${id}`);
        }

        // Update the ModelRecord with final database state
        const dbResult = SqlUtils.convertPostgreSQLTypes(result.rows[0], model);
        record.setCurrent(dbResult);
    }
}
