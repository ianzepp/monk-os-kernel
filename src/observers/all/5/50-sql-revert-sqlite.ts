/**
 * SQL Revert Observer (SQLite) - Ring 5 Database Transport Layer
 *
 * Handles REVERT operations for SQLite - undo soft delete (clear trashed_at).
 * Record already has data loaded; we clear trashed_at and set current.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';

export default class SqlRevertSqliteObserver extends BaseObserver {
    readonly ring = ObserverRing.Database;
    readonly operations = ['revert'] as const;
    readonly adapters = ['sqlite'] as const;
    readonly priority = 50;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        const id = record.get('id');
        if (!id) {
            throw new SystemError('Revert record must have id field');
        }

        const timestamp = new Date().toISOString();

        // Revert: clear trashed_at and update updated_at
        // Only revert actually trashed records
        const updateQuery = `UPDATE "${model.model_name}" SET trashed_at = NULL, updated_at = $1 WHERE "id" = $2 AND "trashed_at" IS NOT NULL`;
        const result = await system.adapter!.query(updateQuery, [timestamp, id]);

        if (result.rowCount === 0) {
            throw new SystemError(`Revert operation failed - record not found or not trashed: ${id}`);
        }

        // Update ModelRecord with reverted state (no SELECT needed)
        const currentState = record.toObject();
        record.setCurrent({
            ...currentState,
            trashed_at: null,
            updated_at: timestamp,
        });
    }
}
