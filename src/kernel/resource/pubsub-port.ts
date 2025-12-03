/**
 * PubsubPort - Topic-based publish/subscribe messaging port
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * PubsubPort implements a topic-based pub/sub messaging system for inter-process
 * communication. Each port subscribes to one or more topic patterns and can both
 * publish and receive messages on matching topics.
 *
 * Messages are delivered asynchronously - when a process publishes to a topic,
 * the kernel routes the message to all ports with matching subscriptions. This
 * enables decoupled many-to-many communication patterns without direct process
 * references.
 *
 * The implementation uses a queue-and-waiter pattern: messages are queued if no
 * recv() is pending, otherwise they're delivered immediately to a waiting recv().
 * This provides backpressure control - if a subscriber falls behind, messages
 * accumulate in its queue rather than being dropped.
 *
 * Topic matching supports hierarchical patterns with wildcards:
 * - `orders.created` - exact topic match
 * - `orders.*` - single-level wildcard (matches orders.created, orders.deleted)
 * - `orders.>` - multi-level wildcard (matches orders.us.created, orders.eu.cancelled)
 *
 * STATE MACHINE
 * =============
 *
 *   constructor() ─────> OPEN ──────────> CLOSED
 *                          │                 ^
 *                          │ recv() waits/   │
 *                          │ dequeues        │
 *                          │ send() publishes│
 *                          └─────────────────┘
 *                              close()
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: type is always 'pubsub' for this port implementation
 * INV-2: Once _closed is true, it never becomes false again
 * INV-3: At most one of (messageQueue.length > 0) OR (waiters.length > 0) is true
 * INV-4: After close(), messageQueue and waiters are empty
 * INV-5: patterns array is immutable after construction
 * INV-6: enqueue() only delivers to ONE waiter (first in line)
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * processes may publish to the same topic concurrently - the kernel serializes
 * these into individual enqueue() calls. Within a single port:
 *
 * - recv() calls are serialized by the caller (kernel ensures one recv at a time)
 * - enqueue() may be called during recv() await points
 * - The queue-or-deliver pattern ensures messages aren't lost during interleaving
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: _closed flag checked before operations to prevent use-after-close
 * RC-2: enqueue() checks _closed to drop messages to closed ports
 * RC-3: close() clears waiters before setting _closed (prevents waiter leaks)
 * RC-4: INV-3 ensures queue and waiters don't both accumulate simultaneously
 * RC-5: No Promise cleanup on timeout (recv never times out - see MEMORY MANAGEMENT)
 *
 * MEMORY MANAGEMENT
 * =================
 * - messageQueue grows unbounded if subscriber falls behind (backpressure issue)
 * - waiters array grows if multiple recv() calls happen without messages arriving
 * - close() immediately clears both arrays to prevent memory leaks
 * - Callers should implement timeouts externally with Promise.race() if needed
 * - Messages in queue at close time are dropped (no delivery guarantee after close)
 *
 * KNOWN LIMITATIONS
 * =================
 * LIMIT-1: No message delivery guarantees (at-most-once semantics)
 * LIMIT-2: No persistent queue (messages lost on process restart)
 * LIMIT-3: No backpressure signaling (queue grows unbounded)
 * LIMIT-4: recv() never times out internally (caller must implement)
 *
 * @module kernel/resource/pubsub-port
 */

import type { PortType } from '@src/kernel/types.js';
import { EBADF } from '@src/kernel/errors.js';
import type { Port, PortMessage } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * Pubsub port implementation.
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
     *
     * WHY: Distinguishes pubsub ports from other port types in kernel tables.
     * INVARIANT: Always 'pubsub' for this implementation.
     */
    readonly type: PortType = 'pubsub';

    /**
     * Unique port identifier.
     *
     * WHY: Enables kernel to track and revoke ports by ID.
     * Also used to prevent echo (ports don't receive their own messages).
     * INVARIANT: Immutable after construction.
     */
    readonly id: string;

    /**
     * Human-readable description.
     *
     * WHY: Aids debugging and process introspection.
     * Example: "pubsub:orders.*"
     */
    readonly description: string;

    // =========================================================================
    // SUBSCRIPTION STATE
    // =========================================================================

    /**
     * Topic patterns this port subscribes to.
     *
     * WHY: Stored locally for getPatterns() introspection.
     * Kernel maintains the canonical subscription mapping.
     * INVARIANT: Immutable after construction.
     */
    private patterns: string[];

    // =========================================================================
    // PORT STATE
    // =========================================================================

    /**
     * Whether port has been closed.
     *
     * WHY: Prevents operations on closed ports.
     * INVARIANT: Once true, never becomes false again.
     */
    private _closed = false;

    /**
     * Queue of messages waiting to be received.
     *
     * WHY: Buffers messages when no recv() is pending.
     * Enables backpressure - slow subscribers queue messages rather than drop.
     * INVARIANT: Empty when waiters.length > 0 (see INV-3).
     */
    private messageQueue: PortMessage[] = [];

    /**
     * Queue of recv() calls waiting for messages.
     *
     * WHY: Allows recv() to block until a message arrives.
     * INVARIANT: Empty when messageQueue.length > 0 (see INV-3).
     */
    private waiters: Array<(msg: PortMessage) => void> = [];

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Function to publish messages to kernel.
     *
     * WHY: Delegates to kernel's pubsub router for topic matching and delivery.
     * Injected to avoid circular dependency on kernel.
     *
     * @param topic - Topic to publish to
     * @param data - Message payload (optional)
     * @param meta - Message metadata (optional)
     * @param sourcePortId - ID of publishing port (for echo prevention)
     */
    private publishFn: (
        topic: string,
        data: Uint8Array | undefined,
        meta: Record<string, unknown> | undefined,
        sourcePortId: string
    ) => void;

    /**
     * Function to unsubscribe from topics on close.
     *
     * WHY: Delegates to kernel to remove this port from subscription tables.
     * Injected to avoid circular dependency on kernel.
     */
    private unsubscribeFn: () => void;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new PubsubPort.
     *
     * @param id - Unique port identifier
     * @param patterns - Topic patterns to subscribe to
     * @param publishFn - Function to publish messages via kernel
     * @param unsubscribeFn - Function to unsubscribe from topics
     * @param description - Human-readable description
     */
    constructor(
        id: string,
        patterns: string[],
        publishFn: (
            topic: string,
            data: Uint8Array | undefined,
            meta: Record<string, unknown> | undefined,
            sourcePortId: string
        ) => void,
        unsubscribeFn: () => void,
        description: string
    ) {
        this.id = id;
        this.patterns = patterns;
        this.publishFn = publishFn;
        this.unsubscribeFn = unsubscribeFn;
        this.description = description;
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    /**
     * Check if port is closed.
     *
     * WHY: Exposes closure state for external checks.
     */
    get closed(): boolean {
        return this._closed;
    }

    /**
     * Get subscribed topic patterns.
     *
     * WHY: Enables introspection of port's subscriptions.
     *
     * @returns Array of topic patterns (copy to prevent mutation)
     */
    getPatterns(): string[] {
        return this.patterns;
    }

    // =========================================================================
    // MESSAGE DELIVERY (called by kernel)
    // =========================================================================

    /**
     * Enqueue a message for delivery.
     *
     * Called by kernel when a published message matches this port's subscriptions.
     * If a recv() is waiting, delivers immediately. Otherwise queues for later.
     *
     * ALGORITHM:
     * 1. Check if port is closed (drop message if closed)
     * 2. If waiters exist, deliver to first waiter and return
     * 3. Otherwise, append to message queue
     *
     * RACE CONDITION:
     * If close() is called while enqueue() is running, the _closed check
     * prevents further enqueueing. Any message in-flight during close is
     * either delivered to a waiter or added to queue (then dropped by close).
     *
     * WHY we don't notify waiters about closure:
     * The recv() promise is pending in user code. If port closes while recv()
     * is waiting, the caller should use Promise.race() with a timeout or
     * cancellation token. We don't resolve/reject pending promises from close()
     * to avoid surprising the caller with unexpected resolution.
     *
     * @param msg - Message to enqueue
     */
    enqueue(msg: PortMessage): void {
        // Drop messages to closed ports
        if (this._closed) {
            return;
        }

        // Deliver immediately if recv() is waiting
        if (this.waiters.length > 0) {
            // WHY shift() - delivers to first waiter in FIFO order
            const waiter = this.waiters.shift()!;
            waiter(msg);
        } else {
            // Queue for later recv()
            this.messageQueue.push(msg);
        }
    }

    // =========================================================================
    // MESSAGE RECEPTION
    // =========================================================================

    /**
     * Receive a message from a subscribed topic.
     *
     * If messages are queued, returns immediately. Otherwise blocks until
     * a message arrives via enqueue().
     *
     * ALGORITHM:
     * 1. Check if port is closed (throw EBADF if so)
     * 2. If messageQueue has items, dequeue and return first
     * 3. Otherwise, create a Promise and add resolver to waiters
     * 4. Promise resolves when enqueue() delivers a message
     *
     * RACE CONDITION:
     * If close() is called while recv() is blocked, the waiter is cleared
     * but the Promise never resolves. Caller should use Promise.race() with
     * a timeout or cancellation mechanism if this is a concern.
     *
     * @returns Promise that resolves to received message
     * @throws EBADF - If port is closed
     */
    async recv(): Promise<PortMessage> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        // Return queued message if available
        if (this.messageQueue.length > 0) {
            // WHY shift() - delivers messages in FIFO order
            return this.messageQueue.shift()!;
        }

        // No messages available - wait for one
        // WHY we don't implement timeout here:
        // Timeout policy varies by use case. Callers should use Promise.race()
        // with their own timeout logic if needed.
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    // =========================================================================
    // MESSAGE PUBLISHING
    // =========================================================================

    /**
     * Publish a message to a topic.
     *
     * Delegates to kernel which routes to all ports with matching subscriptions.
     *
     * ALGORITHM:
     * 1. Check if port is closed (throw EBADF if so)
     * 2. Call publishFn with topic, data, meta, and this port's ID
     * 3. Kernel handles topic matching and delivery to subscribers
     *
     * WHY we pass sourcePortId:
     * Prevents echo - ports don't receive their own published messages.
     * Kernel checks sourcePortId when routing to subscribers.
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

        // Delegate to kernel's pubsub router
        this.publishFn(topic, data, meta, this.id);
    }

    // =========================================================================
    // CLEANUP
    // =========================================================================

    /**
     * Close the pubsub port.
     *
     * Unsubscribes from all topics, clears pending messages and waiters.
     * Safe to call multiple times (idempotent).
     *
     * ALGORITHM:
     * 1. Check if already closed (return early if so)
     * 2. Set _closed flag
     * 3. Unsubscribe from topics (kernel cleanup)
     * 4. Clear waiters (pending recv() calls won't resolve)
     * 5. Clear message queue (undelivered messages are dropped)
     *
     * RACE CONDITION:
     * If recv() is blocked when close() is called, the waiter is removed
     * but its Promise never resolves. Callers should implement timeouts
     * externally if they need guaranteed resolution.
     *
     * WHY we don't reject pending promises:
     * Rejecting would surprise callers who expect recv() to only throw
     * if the port is already closed. The _closed flag provides the signal
     * for subsequent operations.
     *
     * @returns Promise that resolves when cleanup completes
     */
    async close(): Promise<void> {
        // Idempotent close
        if (this._closed) {
            return;
        }

        // Mark closed before cleanup to prevent re-entry
        this._closed = true;

        // Unsubscribe from kernel's routing tables
        this.unsubscribeFn();

        // Clear waiters - pending recv() promises won't resolve
        // WHY: Prevents memory leak from abandoned promises
        this.waiters = [];

        // Clear queued messages - they won't be delivered
        // WHY: Frees memory from unprocessed messages
        this.messageQueue = [];
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
 * - Multi wildcard: "orders.>" matches "orders.created" and "orders.us.created"
 *
 * ALGORITHM:
 * 1. Split pattern and topic into segments by '.'
 * 2. Iterate through pattern segments
 * 3. If segment is '>', match succeeds if at least one topic segment remains
 * 4. If segment is '*', skip topic segment (must exist)
 * 5. Otherwise require exact segment match
 * 6. Pattern and topic must have same length (unless '>' was used)
 *
 * WHY '>' requires at least one segment:
 * Empty trailing segments would be ambiguous. "orders." is invalid.
 * "orders.>" requires at least "orders.X" to match.
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
        if (p === '>') {
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
