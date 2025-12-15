/**
 * PubsubNotify Observer - Ring 9 Entity Change Notifications
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This observer publishes entity changes to the pub/sub system after all
 * database and cache operations complete. This enables:
 *
 * - Real-time entity change notifications via watch()
 * - Cross-node event propagation (when using Redis backend)
 * - SSE/WebSocket push notifications to clients
 *
 * TOPIC FORMAT
 * ============
 * Messages are published to topics in the format:
 *   entity.{model}.{operation}
 *
 * Examples:
 * - entity.user.create    - New user created
 * - entity.invoice.update - Invoice updated
 * - entity.task.delete    - Task soft-deleted
 *
 * MESSAGE FORMAT
 * ==============
 * Each message contains:
 * - id: Entity ID
 * - model: Model name
 * - data: Full entity record (for create/update) or null (for delete)
 * - changes: Changed fields (for update only)
 *
 * INVARIANTS
 * ==========
 * INV-1: Only publishes after successful database commit (Ring 5 complete)
 * INV-2: Uses fire-and-forget - publish failures don't fail the operation
 * INV-3: All three operations (create, update, delete) publish notifications
 *
 * CONCURRENCY MODEL
 * =================
 * This observer executes after all other rings complete. The publish is
 * async but awaited - we don't want to return to caller before notification
 * is sent. However, publish failures are caught and logged, not thrown.
 *
 * @module ems/ring/9/pubsub-notify
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import type { EntitySystemContext } from '../../entity-ops.js';
import { debug } from '../../../debug.js';

const log = debug('ems:pubsub');

// =============================================================================
// PUBSUB NOTIFY OBSERVER
// =============================================================================

/**
 * Publishes entity changes to pub/sub system.
 *
 * Runs in Ring 9 (Notification) after all database and cache operations.
 * Uses HAL redis for pub/sub to enable cross-node event propagation.
 */
export class PubsubNotify extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'PubsubNotify';

    /**
     * Ring 9 = Notification (internal events, pub/sub).
     *
     * WHY Ring 9: After database (5), DDL (6), audit (7), and cache (8).
     * Notifications are the last step - all state is finalized.
     */
    readonly ring = ObserverRing.Notification;

    /**
     * Priority 99 = late in ring.
     *
     * WHY 99: Leaves room for other notification observers if needed.
     * Pub/sub is typically the final notification mechanism.
     */
    readonly priority = 99;

    /**
     * Handles all mutation operations.
     */
    readonly operations: readonly OperationType[] = ['create', 'update', 'delete'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Publish entity change notification.
     *
     * ALGORITHM:
     * 1. Build topic from model name and operation
     * 2. Build payload with entity data
     * 3. Publish via HAL redis (fire-and-forget semantics)
     *
     * @param context - Observer context
     */
    async execute(context: ObserverContext): Promise<void> {
        const { operation, model, record } = context;
        const system = context.system as EntitySystemContext;

        // Skip if HAL not available (shouldn't happen in production)
        if (!system.hal?.redis) {
            log('HAL redis not available, skipping pubsub notification');
            return;
        }

        const topic = `entity.${model.modelName}.${operation}`;
        const data = record.toRecord();
        const entityId = data.id as string ?? 'unknown';

        // Build payload based on operation
        const payload: PubsubPayload = {
            id: entityId,
            model: model.modelName,
            operation,
            data: operation === 'delete' ? null : data,
            changes: operation === 'update' ? record.toChanges() : undefined,
            timestamp: new Date().toISOString(),
        };

        try {
            const subscribers = await system.hal.redis.publish(topic, payload);

            log(`published ${topic} (${entityId}) to ${subscribers} subscriber(s)`);
        }
        catch (err) {
            // Fire-and-forget: log but don't fail the operation
            const message = err instanceof Error ? err.message : String(err);

            log(`publish failed for ${topic}: ${message}`);
        }
    }
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Payload published for entity changes.
 */
interface PubsubPayload {
    /** Entity ID */
    id: string;

    /** Model name */
    model: string;

    /** Operation type */
    operation: OperationType;

    /** Full entity data (null for delete) */
    data: Record<string, unknown> | null;

    /** Changed fields (update only) */
    changes?: Record<string, unknown>;

    /** ISO timestamp of the event */
    timestamp: string;
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default PubsubNotify;
