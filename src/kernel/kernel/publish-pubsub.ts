/**
 * Pubsub Message Routing - Deliver published messages to matching subscribers
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Monk OS provides in-kernel pubsub messaging for process coordination. Processes
 * create pubsub ports with topic patterns (e.g., "log.*", "metrics.cpu"), then
 * send/receive messages on matching topics. This module routes published messages
 * to all subscribers with matching patterns.
 *
 * This is the kernel's message bus - a synchronous, in-memory delivery system
 * for inter-process communication without explicit connections.
 *
 * PUBSUB MODEL
 * ============
 * Publisher: Sends message to topic (e.g., "log.kernel.boot")
 * Kernel: Routes to all ports subscribed to matching patterns
 * Subscribers: Receive message on their pubsub port
 *
 * Pattern matching:
 * - Exact: "log.kernel" matches "log.kernel" only
 * - Wildcard: "log.*" matches "log.kernel", "log.user", "log.anything"
 * - Multi-level: "log.**" matches "log.a", "log.a.b", "log.a.b.c"
 *
 * MESSAGE DELIVERY
 * ================
 * Delivery is synchronous and best-effort:
 * - Iterate all registered pubsub ports
 * - For each port, check if any pattern matches topic
 * - If match, enqueue message to port's buffer
 * - Don't echo message back to sender (skip sourcePortId)
 * - Each port receives at most one copy (break after first match)
 *
 * NO GUARANTEE: If port buffer is full, message is dropped (backpressure).
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All pubsub ports must be registered in kernel.pubsubPorts set
 *        VIOLATED BY: Skipping registration breaks message delivery
 * INV-2: sourcePortId must be valid (matches sender's port ID)
 *        VIOLATED BY: Messages echoed to sender (no-echo check fails)
 * INV-3: Topic must be non-empty string
 *        VIOLATED BY: Caller validation (not enforced here)
 * INV-4: Each subscriber receives message at most once per publish
 *        VIOLATED BY: Not breaking after first pattern match
 *
 * CONCURRENCY MODEL
 * =================
 * This function is called synchronously from pubsub port send operations.
 * No async operations, runs on caller's thread. However, multiple publishers
 * could call this concurrently, iterating the same pubsubPorts set.
 *
 * RACE CONDITION: Port added/removed during iteration
 * - Publisher iterates pubsubPorts, finds matching port
 * - Another process closes port, removes from set
 * - We try to enqueue to closed port
 * - MITIGATION: Port.enqueue() is safe on closed port (no-op)
 * - No crash, message just not delivered
 *
 * RACE CONDITION: Pattern modified during iteration
 * - Publisher checks port.getPatterns(), finds match
 * - Another syscall modifies port's patterns
 * - Message delivered with stale pattern check
 * - MITIGATION: Patterns are immutable after port creation
 * - No race possible (patterns never modified)
 *
 * RACE CONDITION: Multiple publishers to same topic
 * - Two processes publish to "log.kernel" concurrently
 * - Both iterate pubsubPorts, both enqueue to same subscriber
 * - Subscriber receives messages in arbitrary order
 * - MITIGATION: This is correct behavior (no ordering guarantee)
 * - Pubsub is best-effort, unordered
 *
 * MEMORY MANAGEMENT
 * =================
 * - Does NOT allocate message copies (passes data reference)
 * - Port.enqueue() creates PortMessage wrapper
 * - Message held in port buffer until process calls recv()
 * - If buffer full, message dropped (no memory leak)
 * - Timestamp added to metadata (lightweight, just number)
 *
 * PERFORMANCE
 * ===========
 * O(N*M) where N = number of pubsub ports, M = patterns per port
 * For each port, checks all patterns until match found
 * Optimization: breaks after first match (one delivery per port)
 *
 * Scaling considerations:
 * - 100 ports * 10 patterns = 1000 comparisons per publish
 * - Pattern matching is regex-based (potentially slow)
 * - Future: topic index (trie) for O(log N) lookup
 *
 * @module kernel/kernel/publish-pubsub
 */

import type { Kernel } from '../kernel.js';
import { matchTopic } from '../resource.js';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Publish a message to all pubsub subscribers with matching topic patterns.
 *
 * Routes message to all registered pubsub ports whose patterns match the topic.
 * Does not echo message back to sender. Adds timestamp to metadata.
 *
 * ALGORITHM:
 * 1. Create message object with from, data, meta (including timestamp)
 * 2. For each registered pubsub port:
 *    a. Skip if port is sender (no echo)
 *    b. For each pattern in port's subscriptions:
 *       i.  Check if pattern matches topic
 *       ii. If match: enqueue message, break (one delivery per port)
 * 3. Return (synchronous, no await)
 *
 * WHY SYNCHRONOUS: All operations are in-memory, no I/O.
 * Message routing happens on publisher's thread for minimal latency.
 *
 * DESIGN CHOICE: Why timestamp in metadata?
 * - Allows subscribers to order messages from different sources
 * - Useful for log aggregation, metrics collection
 * - Low cost: just Date.now() (or deps.now() for testing)
 *
 * DESIGN CHOICE: Why no-echo check?
 * - Prevents publisher from receiving own message
 * - Publisher already knows what it sent, no need to deliver back
 * - Reduces message fanout, improves efficiency
 *
 * DESIGN CHOICE: Why break after first match?
 * - Port should receive message once, not multiple times
 * - If port subscribes to ["log.*", "log.kernel"], both match "log.kernel"
 * - Deliver once (first match), not twice
 * - Reduces duplicate messages, improves clarity
 *
 * DESIGN CHOICE: Why not buffer full check?
 * - Port.enqueue() handles full buffer internally
 * - Either drops message or blocks (port implementation choice)
 * - Caller doesn't need to know about backpressure
 * - Keeps routing logic simple
 *
 * EDGE CASE: No matching subscribers
 * - Message not delivered anywhere
 * - This is correct behavior (not an error)
 * - Publisher doesn't get notification (fire-and-forget)
 *
 * EDGE CASE: Closed port in pubsubPorts set
 * - Port.enqueue() is safe on closed port (no-op)
 * - Port should be removed from set when closed
 * - If not, message just not delivered (no crash)
 *
 * @param self - Kernel instance
 * @param topic - Topic to publish to (e.g., "log.kernel.boot")
 * @param data - Message payload (raw bytes, may be undefined)
 * @param meta - Message metadata (arbitrary object, may be undefined)
 * @param sourcePortId - Sender's port ID (to prevent echo)
 */
export function publishPubsub(
    self: Kernel,
    topic: string,
    data: Uint8Array | undefined,
    meta: Record<string, unknown> | undefined,
    sourcePortId: string,
): void {
    // Create message object with timestamp
    // WHY SPREAD META: Preserve existing metadata from sender
    // WHY TIMESTAMP: Add delivery time for subscriber ordering
    const message = {
        from: topic,                        // Topic is "from" field (not sender ID)
        data,                                // Raw bytes (may be undefined)
        meta: {
            ...meta,                         // Existing metadata from sender
            timestamp: self.deps.now(),     // Add current timestamp (milliseconds)
        },
    };

    // Route message to all matching subscribers
    for (const port of self.pubsubPorts) {
        // NO-ECHO: Don't deliver message back to sender
        // WHY: Publisher already knows what it sent
        if (port.id === sourcePortId) {
            continue;
        }

        // Check if any of port's patterns match the topic
        for (const pattern of port.getPatterns()) {
            if (matchTopic(pattern, topic)) {
                // MATCH: Deliver message to this port
                port.enqueue(message);

                // ONE DELIVERY PER PORT: Don't check remaining patterns
                // WHY: Port should receive message once, not multiple times
                break;
            }
        }
    }

    // SYNCHRONOUS RETURN: All routing done, message delivered (or dropped)
    // Publisher doesn't know how many subscribers received it (fire-and-forget)
}
