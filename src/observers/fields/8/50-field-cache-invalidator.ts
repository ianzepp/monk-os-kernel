/**
 * Field Cache Invalidator - Ring 8 Integration
 *
 * Automatically invalidates NamespaceCache when fields are modified.
 * Field changes affect the parent model's cached metadata,
 * so we must both update the parent model's timestamp and invalidate the cache.
 *
 * This observer runs AFTER database changes are committed (Ring 8), ensuring
 * that cache is only invalidated for successfully persisted changes.
 *
 * Ring: 8 (Integration) - After database changes are committed
 * Model: fields
 * Operations: create, update, delete
 */

import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class FieldCacheInvalidator extends BaseObserver {
    readonly ring = ObserverRing.Integration;  // Ring 8
    readonly operations = ['create', 'update', 'delete'] as const;
    readonly models = ['fields'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;
        const { model_name, field_name } = record;

        if (!model_name) {
            console.warn('Cannot invalidate model cache - no model_name in field record', {
                record,
                operation: context.operation,
                field_name
            });
            return;
        }

        // Update parent model's updated_at timestamp in database
        // This ensures timestamp-based cache validation detects field changes
        const query = `UPDATE models SET updated_at = now() WHERE model_name = $1`;
        await SqlUtils.getPool(context.system).query(query, [model_name]);

        // Invalidate NamespaceCache and reload
        context.system.namespace.invalidateModel(model_name);
        await context.system.namespace.loadOne(context.system, model_name);

        console.info('Model cache invalidated by field change', {
            operation: context.operation,
            model_name,
            field_name,
            ring: this.ring,
            reason: 'field definition modified'
        });
    }
}
