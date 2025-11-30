/**
 * DDL Update Observer - Ring 6 PostDatabase
 *
 * Handles model updates in ring 6. Since model updates only affect metadata
 * (status field), no DDL operations are needed. Table structure changes happen
 * via field operations, not model updates.
 *
 * This observer exists for completeness but is essentially a no-op.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class ModelDdlUpdateObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['update'] as const;
    readonly adapters = ['postgresql'] as const;  // PostgreSQL DDL
    readonly models = ['models'] as const;
    readonly priority = 10;  // High priority - DDL should run before data transformations

    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;
        const { model_name, external, status } = record;

        // Skip DDL operations for external models (managed elsewhere)
        if (external === true) {
            console.info(`Skipping DDL operation for external model: ${model_name}`);
            return;
        }

        // Model updates only affect metadata (status field)
        // No DDL operations needed - table structure is managed by field operations
        console.debug(`Model metadata updated: ${model_name}`, {
            status
        });

        // No DDL execution - this is intentionally a no-op
    }
}
