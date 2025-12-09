/**
 * Resource Types - Port and Message interfaces for kernel I/O
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines the core abstractions for kernel-level message endpoints
 * (Ports) and the messages they exchange. Ports are a subset of the unified
 * Handle architecture, providing a specialized interface for event-driven and
 * datagram-style communication patterns.
 *
 * Ports sit at the intersection of kernel and network layers. They enable
 * userspace processes to receive events (file system changes, network packets,
 * pub/sub messages) and incoming connections (TCP listeners) without exposing
 * the underlying HAL primitives. The Port abstraction provides a uniform
 * message-based interface regardless of the underlying transport.
 *
 * WHY Ports exist separately from Handles:
 * - Handles use exec(Message) → AsyncIterable<Response> (request/response)
 * - Ports use recv() → Promise<PortMessage> (event-driven, one direction)
 * - Some Ports support send() for bidirectional datagram patterns (UDP)
 * - TCP listeners yield Socket handles, not data - they're connection factories
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Every PortMessage must have a non-empty 'from' field identifying source
 * INV-2: UDP ports MUST include data (network boundary requires bytes)
 * INV-3: Pubsub/watch ports MAY omit data, using meta for structured messages
 * INV-4: TCP listener PortMessages MUST include socket handle, not data
 * INV-5: Once closed is true, recv() and send() operations must throw EBADF
 * INV-6: Port IDs are globally unique (generated via HAL entropy device)
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * concurrent recv() calls on the same port are NOT supported - callers must
 * serialize access. This matches POSIX socket semantics where multiple threads
 * reading from the same fd creates a race for which thread receives data.
 *
 * Port implementations use internal queues for incoming messages. When recv()
 * is called and the queue is empty, it creates a Promise that resolves when
 * the next message arrives. This allows backpressure - if no one is calling
 * recv(), the queue grows until kernel backpressure mechanisms engage.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Close flag checked before every recv()/send() operation
 * RC-2: Internal message queues use pending resolver pattern to avoid lost messages
 * RC-3: Port close() drains pending messages before marking closed
 *
 * MEMORY MANAGEMENT
 * =================
 * - Ports hold references to HAL resources (sockets, watchers, subscriptions)
 * - close() must release all HAL resources to prevent leaks
 * - Pending messages in queue are released when port closes
 * - Callers should use explicit close() or rely on kernel cleanup on process exit
 *
 * @module kernel/resource/types
 */

import type { Socket } from '@src/hal/index.js';
import type { PortType } from '@src/kernel/types.js';

// =============================================================================
// RE-EXPORTS
// =============================================================================

/**
 * Re-export PortType from kernel types.
 *
 * WHY: Centralize PortType definition in kernel/types.ts but allow
 * consumers to import from this module for convenience.
 */
export type { PortType } from '@src/kernel/types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Message received from a port.
 *
 * Different port types use different combinations of fields:
 *
 * tcp:listen - Connection accepted from TCP listener
 *   - from: remote address (e.g., "192.168.1.100:54321")
 *   - socket: accepted Socket handle for bidirectional communication
 *   - data: undefined (connection itself is the event, not data)
 *   - meta: undefined
 *
 * udp - Datagram received on UDP socket
 *   - from: remote address (e.g., "192.168.1.100:54321")
 *   - data: packet payload (REQUIRED - network boundary demands bytes)
 *   - socket: undefined
 *   - meta: undefined
 *
 * watch - File system event
 *   - from: file path that changed (e.g., "/var/log/app.log")
 *   - meta: { op: 'create'|'update'|'delete', timestamp: number }
 *   - data: optional (usually undefined - metadata is in meta field)
 *   - socket: undefined
 *
 * pubsub - Topic message received
 *   - from: topic name (e.g., "log.error" or "events.user.login")
 *   - meta: structured message payload (primary data carrier)
 *   - data: optional (may include if crossing serialization boundary)
 *   - socket: undefined
 *
 * INVARIANT: from is always non-empty and identifies message source.
 * INVARIANT: UDP messages always include data (network requires bytes).
 * INVARIANT: TCP listener messages always include socket.
 */
export interface PortMessage {
    /**
     * Source identifier for this message.
     *
     * Format depends on port type:
     * - tcp:listen: Remote IP:port (e.g., "192.168.1.100:54321")
     * - udp: Remote IP:port
     * - watch: File path (e.g., "/var/log/app.log")
     * - pubsub: Topic name (e.g., "log.error")
     *
     * WHY: Enables routing, filtering, and reply-to semantics.
     * INVARIANT: Never empty string or undefined.
     */
    from: string;

    /**
     * Binary payload.
     *
     * WHY required for UDP:
     * Network is a byte boundary. Datagram payloads must be bytes, not
     * structured objects, because they cross process/machine boundaries.
     *
     * WHY optional for pubsub/watch:
     * Internal kernel messages can use structured meta field directly.
     * Bytes are only needed when crossing serialization boundaries.
     *
     * INVARIANT: Required for UDP, optional for watch/pubsub.
     */
    data?: Uint8Array;

    /**
     * Accepted socket for tcp:listen.
     *
     * WHY:
     * TCP listeners don't receive data - they receive new connections.
     * Each connection is a bidirectional Socket handle that can be used
     * for subsequent read/write operations.
     *
     * INVARIANT: Only present for tcp:listen port messages.
     */
    socket?: Socket;

    /**
     * Structured metadata.
     *
     * WHY:
     * For internal kernel messages (watch, pubsub), this is the primary
     * data carrier. Structured objects are more efficient than serializing
     * to bytes when staying inside the same process.
     *
     * Examples:
     * - watch: { op: 'update', timestamp: 1234567890 }
     * - pubsub: { level: 'error', message: 'Database connection failed' }
     *
     * INVARIANT: Optional for all port types, but primary carrier for watch/pubsub.
     */
    meta?: Record<string, unknown>;
}

/**
 * Base port interface.
 *
 * Ports are message endpoints that provide event-driven I/O patterns.
 * Unlike Handles (which use request/response exec() pattern), Ports use
 * recv() for one-way message flow and optional send() for replies.
 *
 * Port lifecycle:
 * 1. Created by kernel (via listen(), watch(), subscribe() syscalls)
 * 2. Messages received via recv() (blocks until message available)
 * 3. Optional: send messages via send() (UDP only)
 * 4. Closed explicitly or by kernel on process exit
 *
 * TESTABILITY: All ports expose id, type, description for inspection.
 * Tests can verify correct port type and track lifecycle.
 */
export interface Port {
    /**
     * Unique port identifier.
     *
     * WHY:
     * Enables kernel to track ports globally, reference them in file
     * descriptor tables, and ensure cleanup on process exit.
     *
     * INVARIANT: Globally unique (generated via HAL entropy device).
     */
    readonly id: string;

    /**
     * Port type discriminator.
     *
     * WHY:
     * Allows kernel to dispatch operations correctly and validate
     * compatibility (e.g., send() only works on UDP ports).
     *
     * INVARIANT: One of 'tcp:listen' | 'udp:bind' | 'fs:watch' | 'pubsub:subscribe'.
     */
    readonly type: PortType;

    /**
     * Human-readable description.
     *
     * WHY:
     * Debugging and diagnostics. Examples:
     * - "tcp:listen:0.0.0.0:8080"
     * - "fs:watch:/var/log/*.log"
     * - "pubsub:subscribe:log.*"
     * - "udp:bind:0.0.0.0:9000"
     *
     * TESTABILITY: Useful for test assertions and error messages.
     */
    readonly description: string;

    /**
     * Receive next message from port.
     *
     * Blocks until a message is available or port is closed.
     *
     * ALGORITHM:
     * 1. Check if port is closed (throw EBADF if true)
     * 2. If message queue has items, dequeue and return immediately
     * 3. Otherwise, create Promise and add to pending resolvers list
     * 4. When next message arrives, resolve oldest pending Promise
     *
     * RACE CONDITION:
     * Multiple concurrent recv() calls create race for which gets next
     * message. Callers must serialize recv() access. This matches POSIX
     * semantics for socket recv().
     *
     * @returns Promise resolving to next PortMessage
     * @throws EBADF - If port is closed
     */
    recv(): Promise<PortMessage>;

    /**
     * Send message to destination.
     *
     * Not all ports support sending:
     * - udp: YES - send datagrams to remote address
     * - tcp:listen: NO - listeners only accept connections
     * - watch: NO - file system events are read-only
     * - pubsub: YES - publish to topic (via kernel message system)
     *
     * WHY data is optional:
     * Internal messages (pubsub) can use meta field without serializing
     * to bytes. Network messages (UDP) require data.
     *
     * @param to - Destination address (format depends on port type)
     * @param data - Optional binary payload
     * @param meta - Optional structured metadata
     * @returns Promise resolving when send completes
     * @throws EBADF - If port is closed
     * @throws EINVAL - If port type doesn't support sending
     */
    send(to: string, data?: Uint8Array, meta?: Record<string, unknown>): Promise<void>;

    /**
     * Close port and release resources.
     *
     * ALGORITHM:
     * 1. Mark port as closed
     * 2. Drain pending message queue (reject pending recv() calls)
     * 3. Release underlying HAL resources (socket, watcher, subscription)
     * 4. Subsequent recv()/send() calls throw EBADF
     *
     * Safe to call multiple times - subsequent calls are no-ops.
     *
     * @returns Promise resolving when cleanup completes
     */
    close(): Promise<void>;

    /**
     * Check if port is closed.
     *
     * WHY:
     * Allows callers to check state before attempting operations.
     * Useful for cleanup code and error handling.
     *
     * INVARIANT: Once true, never becomes false again.
     */
    readonly closed: boolean;
}

// =============================================================================
// OPTIONS
// =============================================================================

/**
 * UDP socket options.
 *
 * Specifies local binding configuration for UDP sockets. UDP is
 * connectionless - there's no connect() operation. Instead, bind()
 * determines the local address/port that will receive datagrams.
 *
 * TESTABILITY: Exposed interface allows tests to verify binding configuration.
 */
export interface UdpSocketOpts {
    /**
     * Local port to bind.
     *
     * WHY:
     * UDP sockets must bind to a port to receive messages. Port 0
     * lets the kernel choose an ephemeral port.
     *
     * INVARIANT: 0-65535 range (validated by HAL network device).
     */
    port: number;

    /**
     * Local address to bind.
     *
     * WHY default is 0.0.0.0:
     * Binding to 0.0.0.0 accepts datagrams on all interfaces. This is
     * the most common use case for server sockets.
     *
     * Binding to 127.0.0.1 restricts to loopback (localhost only).
     * Binding to specific IP restricts to that interface.
     *
     * @default "0.0.0.0"
     */
    host?: string;
}
