/**
 * Update Merger Observer
 *
 * SIMPLIFIED with ModelRecord: Now just sets updated_at timestamp.
 * The actual merging of existing + update data is handled by ModelRecord.toObject()
 * which is called in the SQL layer.
 *
 * This observer ensures:
 * - updated_at timestamp is set for all update operations
 * - Timestamp is not set if explicitly provided (for imports/migrations)
 *
 * Ring: 0 (DataPreparation) - Model: all - Operations: update
 */

import { BaseObserver } from '@src/lib/observers/base-observer.js';
import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { ObserverRing } from '@src/lib/observers/types.js';

export default class UpdateMerger extends BaseObserver {
    readonly ring = ObserverRing.DataPreparation;
    readonly operations = ['update'] as const;
    readonly priority = 50; // Run after record preloading in Database class

    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;

        // Set updated_at timestamp (unless explicitly provided)
        if (!record.has('updated_at')) {
            record.set('updated_at', new Date().toISOString());
        }
    }
}
