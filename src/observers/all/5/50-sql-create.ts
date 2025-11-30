/**
 * SQL Create Observer - Ring 5 Database Transport Layer
 *
 * Handles CREATE operations - direct SQL execution for inserting new records.
 * Operates on pre-validated, pre-processed data from earlier observer rings.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';

export default class SqlCreateObserver extends BaseObserver {
    readonly ring = ObserverRing.Database;
    readonly operations = ['create'] as const;
    readonly adapters = ['postgresql'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        const timestamp = new Date().toISOString();

        // Convert ModelRecord to plain object for SQL operations
        const plainRecord = record.toObject();

        // Set up record with required system fields
        const recordWithDefaults = {
            id: plainRecord.id || SqlUtils.generateId(),
            created_at: plainRecord.created_at || timestamp,
            updated_at: plainRecord.updated_at || timestamp,
            ...plainRecord,
        };

        // Process UUID arrays for PostgreSQL compatibility
        let processedRecord = SqlUtils.processUuidArrays(recordWithDefaults);

        // Process JSONB fields (objects/arrays) for PostgreSQL serialization
        processedRecord = SqlUtils.processJsonbFields(processedRecord, model);

        // Build parameterized INSERT query
        const fields = Object.keys(processedRecord);
        const values = Object.values(processedRecord);
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
        const fieldList = fields.map(field => `"${field}"`).join(', ');

        const query = `INSERT INTO "${model.model_name}" (${fieldList}) VALUES (${placeholders}) RETURNING *`;

        let result;
        try {
            result = await SqlUtils.getPool(system).query(query, values);
        } catch (error) {
            throw new SystemError(
                `Failed to insert record into ${model.model_name}: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        if (result.rows.length === 0) {
            throw new SystemError(`Failed to create record in ${model.model_name}`);
        }

        // Update the ModelRecord with final database state
        const dbResult = SqlUtils.convertPostgreSQLTypes(result.rows[0], model);
        record.setCurrent(dbResult);
    }
}
