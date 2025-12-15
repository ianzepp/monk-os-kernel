/**
 * PubsubPort - Topic-based publish/subscribe messaging port
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * PubsubPort provides topic-based pub/sub messaging for inter-process
 * communication. It delegates all subscription management and message routing
 * to the HAL Redis device, which can use either an in-memory backend (for
 * single-node deployments) or an external Redis server (for distributed
 * deployments).
 *
 * This delegation enables:
 * - Cross-node pub/sub when using Redis backend
 * - Consistent behavior between dev (memory) and prod (Redis)
 * - Simplified kernel code (no routing logic)
 *
 * Topic matching supports glob-style patterns:
 * - `orders.created` - exact topic match
 * - `orders.*` - single-level wildcard (matches orders.created, orders.deleted)
 * - `orders.**` - multi-level wildcard (matches orders.us.created, orders.eu.cancelled)
 *
 * STATE MACHINE
 * =============
 *
 *   constructor() ─────> OPEN ──────────> CLOSED
 *                          │                 ^
 *                          │ recv() reads    │
 *                          │ send() publishes│
 *                          └─────────────────┘
 *                              close()
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: type is always 'pubsub:subscribe' for this port implementation
 * INV-2: Once _closed is true, it never becomes false again
 * INV-3: After close(), subscription is closed and no more messages arrive
 * INV-4: patterns array is immutable after construction
 *
 * CONCURRENCY MODEL
 * =================
 * Message delivery is handled by HAL Redis device. Multiple processes can
 * publish to the same topic concurrently - Redis/memory backend handles
 * serialization.
 *
 * MEMORY MANAGEMENT
 * =================
 * - PubsubPort holds a reference to HAL redis subscription
 * - close() releases the subscription
 * - Messages are buffered in HAL redis subscription until recv() is called
 *
 * @module kernel/resource/pubsub-port
 */

import type { PortType } from '@src/kernel/types.js';
import type { HAL, PubsubSubscription } from '@src/hal/index.js';
import { EBADF } from '@src/kernel/errors.js';
import type { Port, PortMessage } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * Pubsub port implementation backed by HAL Redis device.
 *
 * Topic-based publish/subscribe messaging with pattern matching.
 * recv() blocks until a message arrives on a subscribed topic.
 * send() publishes to a topic (delivered to all matching subscribers).
 */
export class PubsubPort implements Port {
    // =========================================================================
    // PORT IDENTITY
    // =========================================================================

    /**
     * Port type identifier.
     */
    readonly type: PortType = 'pubsub:subscribe';

    /**
     * Unique port identifier.
     */
    readonly id: string;

    /**
     * Human-readable description.
     */
    readonly description: string;

    // =========================================================================
    // SUBSCRIPTION STATE
    // =========================================================================

    /**
     * Topic patterns this port subscribes to.
     */
    private readonly patterns: string[];

    /**
     * HAL reference for publishing.
     */
    private readonly hal: HAL;

    /**
     * HAL Redis subscription (created lazily on first recv).
     */
    private subscription: PubsubSubscription | null = null;

    /**
     * Async iterator for receiving messages.
     */
    private messageIterator: AsyncIterator<import('@src/hal/index.js').PubsubMessage> | null = null;

    /**
     * Whether port has been closed.
     */
    private _closed = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new PubsubPort.
     *
     * @param id - Unique port identifier
     * @param hal - HAL instance for redis access
     * @param patterns - Topic patterns to subscribe to
     * @param description - Human-readable description
     */
    constructor(
        id: string,
        hal: HAL,
        patterns: string[],
        description: string,
    ) {
        this.id = id;
        this.hal = hal;
        this.patterns = patterns;
        this.description = description;
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize the subscription.
     *
     * Must be called after construction to set up HAL subscription.
     * Separated from constructor because it's async.
     */
    async init(): Promise<void> {
        if (this.patterns.length > 0) {
            this.subscription = await this.hal.redis.subscribe(this.patterns);
            this.messageIterator = this.subscription.messages()[Symbol.asyncIterator]();
        }
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    /**
     * Check if port is closed.
     */
    get closed(): boolean {
        return this._closed;
    }

    /**
     * Get subscribed topic patterns.
     *
     * @returns Array of topic patterns
     */
    getPatterns(): string[] {
        return this.patterns;
    }

    // =========================================================================
    // MESSAGE RECEPTION
    // =========================================================================

    /**
     * Receive a message from a subscribed topic.
     *
     * Blocks until a message arrives via HAL subscription.
     *
     * @returns Promise that resolves to received message
     * @throws EBADF - If port is closed or has no subscriptions
     */
    async recv(): Promise<PortMessage> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        if (!this.messageIterator) {
            throw new EBADF('Port has no subscriptions (send-only)');
        }

        const result = await this.messageIterator.next();

        if (result.done) {
            throw new EBADF('Subscription closed');
        }

        const msg = result.value;

        // Convert HAL PubsubMessage to kernel PortMessage
        return {
            from: msg.topic,
            data: this.encodePayload(msg.payload),
            meta: {
                pattern: msg.pattern,
                timestamp: Date.now(),
            },
        };
    }

    // =========================================================================
    // MESSAGE PUBLISHING
    // =========================================================================

    /**
     * Publish a message to a topic.
     *
     * Delegates to HAL redis.publish() which routes to all matching subscribers.
     *
     * @param topic - Topic to publish to (e.g., "orders.created")
     * @param data - Optional message payload
     * @param meta - Optional message metadata
     * @throws EBADF - If port is closed
     */
    async send(topic: string, data?: Uint8Array, meta?: Record<string, unknown>): Promise<void> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        // Decode payload and merge with meta
        const payload = {
            data: data ? this.decodePayload(data) : undefined,
            ...meta,
        };

        await this.hal.redis.publish(topic, payload);
    }

    // =========================================================================
    // CLEANUP
    // =========================================================================

    /**
     * Close the pubsub port.
     *
     * Closes HAL subscription. Safe to call multiple times (idempotent).
     *
     * @returns Promise that resolves when cleanup completes
     */
    async close(): Promise<void> {
        if (this._closed) {
            return;
        }

        this._closed = true;

        if (this.subscription) {
            await this.subscription.close();
            this.subscription = null;
            this.messageIterator = null;
        }
    }

    // =========================================================================
    // PAYLOAD ENCODING
    // =========================================================================

    /**
     * Encode a payload for transmission.
     * Converts unknown to Uint8Array via JSON serialization.
     */
    private encodePayload(payload: unknown): Uint8Array | undefined {
        if (payload === undefined || payload === null) {
            return undefined;
        }
        const json = JSON.stringify(payload);
        return new TextEncoder().encode(json);
    }

    /**
     * Decode a payload from transmission.
     * Converts Uint8Array to unknown via JSON deserialization.
     */
    private decodePayload(data: Uint8Array): unknown {
        const json = new TextDecoder().decode(data);
        try {
            return JSON.parse(json);
        }
        catch {
            return json; // Return as string if not valid JSON
        }
    }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Match a topic against a pattern.
 *
 * Implements hierarchical topic matching with wildcard support:
 * - Exact match: "orders.created" matches "orders.created"
 * - Single wildcard: "orders.*" matches "orders.created" and "orders.deleted"
 * - Multi wildcard: "orders.**" matches "orders.created" and "orders.us.created"
 *
 * ALGORITHM:
 * 1. Split pattern and topic into segments by '.'
 * 2. Iterate through pattern segments
 * 3. If segment is '**', match succeeds if at least one topic segment remains
 * 4. If segment is '*', skip topic segment (must exist)
 * 5. Otherwise require exact segment match
 * 6. Pattern and topic must have same length (unless '**' was used)
 *
 * WHY '**' requires at least one segment:
 * Empty trailing segments would be ambiguous. "orders." is invalid.
 * "orders.**" requires at least "orders.X" to match.
 *
 * @param pattern - Topic pattern with optional wildcards
 * @param topic - Topic to test against pattern
 * @returns true if topic matches pattern, false otherwise
 */
export function matchTopic(pattern: string, topic: string): boolean {
    const patternParts = pattern.split('.');
    const topicParts = topic.split('.');

    for (let i = 0; i < patternParts.length; i++) {
        const p = patternParts[i];

        // Multi-level wildcard - matches one or more remaining segments
        if (p === '**') {
            // Must have at least one segment after this position
            // WHY: Prevents matching against "orders." (trailing dot)
            return topicParts.length > i;
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
    // WHY: Prevents "orders" from matching pattern "orders.created"
    return patternParts.length === topicParts.length;
}
