/**
 * Publish a message to matching pubsub subscribers.
 *
 * @module kernel/kernel/publish-pubsub
 */

import type { Kernel } from '../kernel.js';
import { matchTopic } from '../resource.js';

/**
 * Publish a message to matching pubsub subscribers.
 *
 * @param self - Kernel instance
 * @param topic - Topic to publish to
 * @param data - Message data
 * @param meta - Message metadata
 * @param sourcePortId - Source port ID (to avoid echo)
 */
export function publishPubsub(
    self: Kernel,
    topic: string,
    data: Uint8Array | undefined,
    meta: Record<string, unknown> | undefined,
    sourcePortId: string
): void {
    const message = {
        from: topic,
        data,
        meta: {
            ...meta,
            timestamp: self.deps.now(),
        },
    };

    for (const port of self.pubsubPorts) {
        // Don't echo to sender
        if (port.id === sourcePortId) {
            continue;
        }

        // Check pattern match
        for (const pattern of port.getPatterns()) {
            if (matchTopic(pattern, topic)) {
                port.enqueue(message);
                break; // Only deliver once per port
            }
        }
    }
}
