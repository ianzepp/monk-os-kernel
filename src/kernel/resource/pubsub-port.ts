/**
 * Pubsub Port
 *
 * Topic-based publish/subscribe messaging port.
 */

import type { PortType } from '@src/kernel/types.js';
import { EBADF } from '@src/kernel/errors.js';
import type { Port, PortMessage } from './types.js';

/**
 * Pubsub port
 *
 * Topic-based publish/subscribe messaging.
 * recv() blocks until a message arrives on a subscribed topic.
 * send() publishes to a topic (delivered to all matching subscribers).
 *
 * Topic patterns:
 * - `orders.created` - exact topic
 * - `orders.*` - one level wildcard
 * - `orders.>` - multi-level wildcard (all under orders)
 */
export class PubsubPort implements Port {
    readonly type: PortType = 'pubsub';
    private _closed = false;
    private messageQueue: PortMessage[] = [];
    private waiters: Array<(msg: PortMessage) => void> = [];

    constructor(
        readonly id: string,
        private patterns: string[],
        private publishFn: (topic: string, data: Uint8Array, sourcePortId: string) => void,
        private unsubscribeFn: () => void,
        readonly description: string
    ) {}

    get closed(): boolean {
        return this._closed;
    }

    /**
     * Get subscribed patterns
     */
    getPatterns(): string[] {
        return this.patterns;
    }

    /**
     * Enqueue a message (called by kernel when topic matches)
     */
    enqueue(msg: PortMessage): void {
        if (this._closed) return;

        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!;
            waiter(msg);
        } else {
            this.messageQueue.push(msg);
        }
    }

    async recv(): Promise<PortMessage> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        if (this.messageQueue.length > 0) {
            return this.messageQueue.shift()!;
        }

        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    async send(topic: string, data: Uint8Array): Promise<void> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        this.publishFn(topic, data, this.id);
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        this.unsubscribeFn();
        this.waiters = [];
        this.messageQueue = [];
    }
}

/**
 * Match a topic against a pattern.
 *
 * Pattern syntax:
 * - `orders.created` - exact match
 * - `orders.*` - matches one segment (e.g., orders.created, orders.deleted)
 * - `orders.>` - matches one or more segments (e.g., orders.us.created)
 */
export function matchTopic(pattern: string, topic: string): boolean {
    const patternParts = pattern.split('.');
    const topicParts = topic.split('.');

    for (let i = 0; i < patternParts.length; i++) {
        const p = patternParts[i];

        // Multi-level wildcard - matches one or more remaining segments
        if (p === '>') {
            return topicParts.length > i; // Must have at least one segment after this position
        }

        // No more topic parts but pattern continues
        if (i >= topicParts.length) {
            return false;
        }

        // Single-level wildcard - matches any single segment
        if (p === '*') {
            continue;
        }

        // Exact match required
        if (p !== topicParts[i]) {
            return false;
        }
    }

    // Pattern exhausted - topic must also be exhausted
    return patternParts.length === topicParts.length;
}
