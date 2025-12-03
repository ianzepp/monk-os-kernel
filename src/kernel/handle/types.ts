/**
 * Handle Types - Unified handle architecture
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines the core Handle interface and related types for Monk OS's
 * unified I/O architecture. All I/O primitives - files, sockets, pipes, ports,
 * channels, and process I/O streams - implement the Handle interface.
 *
 * The Handle interface provides message-based operations via exec(). This design
 * enables several key properties:
 *
 * 1. Polymorphic I/O: The kernel can dispatch operations to any handle type
 *    without knowing its concrete implementation. A file, socket, and pipe all
 *    respond to the same exec() interface.
 *
 * 2. Streaming responses: Operations return AsyncIterable<Response> rather than
 *    single values. This enables natural backpressure and cancellation - the
 *    kernel can stop iterating if a process is killed.
 *
 * 3. Operation extensibility: New operations can be added without changing the
 *    Handle interface. Each handle type interprets msg.op differently.
 *
 * The HandleType discriminator enables type-based dispatch in the kernel. For
 * example, the kernel might route 'file' handles through a permission checker
 * while 'socket' handles go through a network firewall.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: id is unique across all handles in the system
 * INV-2: type never changes after construction
 * INV-3: Once closed=true, all exec() calls must fail (typically with EBADF)
 * INV-4: close() is idempotent (safe to call multiple times)
 * INV-5: exec() yields at least one Response before completion
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * processes may call exec() on the same handle concurrently. Handle
 * implementations are responsible for:
 *
 * - Serializing writes if order matters (e.g., file writes)
 * - Distributing reads if broadcasts are desired (e.g., channel subscription)
 * - Detecting and reporting conflicts (e.g., exclusive file access)
 *
 * The Handle interface itself provides no concurrency control. This is
 * intentional - different handle types have different needs. Files might need
 * locking, sockets might allow concurrent reads, channels might broadcast.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Handle implementations must check closed state before every async operation
 * RC-2: close() must be safe to call at any time, even mid-operation
 * RC-3: Kernel revokes handles on process exit to prevent use-after-free
 *
 * MEMORY MANAGEMENT
 * =================
 * - Handles own their resources (file descriptors, sockets, etc.)
 * - close() must release all resources
 * - Kernel calls close() on all handles when process exits
 * - Consider implementing Symbol.asyncDispose for `await using` pattern
 *
 * TESTABILITY
 * ===========
 * The Handle interface is designed for testability:
 *
 * - Mock handles can be created by implementing the interface
 * - closed property allows tests to verify cleanup
 * - description enables human-readable test assertions
 * - exec() is pure (given same message, returns same responses)
 *
 * @module kernel/handle/types
 */

import type { Message, Response } from '@src/message.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Handle type discriminator.
 *
 * WHY: Enables type-based dispatch in the kernel without instanceof checks.
 * The kernel can route operations based on handle.type without knowing the
 * concrete implementation class.
 *
 * TYPES:
 * - file: Regular files, devices, console I/O
 * - socket: Network sockets (TCP, UDP, Unix domain)
 * - pipe: Anonymous pipes for process IPC
 * - port: Structured message passing (like Erlang ports)
 * - channel: Broadcast/subscription channels
 * - process-io: Direct I/O to a process (stdin/stdout/stderr)
 *
 * TESTABILITY: String literal type enables exhaustive switch checking.
 */
export type HandleType = 'file' | 'socket' | 'pipe' | 'port' | 'channel' | 'process-io';

/**
 * Unified handle interface.
 *
 * All I/O primitives in Monk OS implement this interface. The kernel dispatches
 * operations by calling exec() with a Message and consuming the Response stream.
 *
 * DESIGN RATIONALE:
 * - Message-based rather than method-based enables protocol extensibility
 * - AsyncIterable rather than Promise enables streaming and backpressure
 * - Single exec() method simplifies kernel dispatch logic
 * - closed property enables fast-path checks without async calls
 *
 * INVARIANTS:
 * - id is unique across all handles
 * - type never changes
 * - Once closed=true, exec() must fail
 * - close() is idempotent
 */
export interface Handle {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Unique handle identifier.
     *
     * WHY: Allows kernel to track handles in tables, revoke on process exit,
     * and correlate handles across operations (e.g., dup2).
     *
     * INVARIANT: Unique across all handles in the system.
     *
     * FORMAT: Typically a UUID, but implementation-defined.
     */
    readonly id: string;

    /**
     * Handle type discriminator.
     *
     * WHY: Enables kernel to dispatch based on handle type without instanceof.
     * For example, file handles might require permission checks while socket
     * handles might require network policy checks.
     *
     * INVARIANT: Never changes after construction.
     */
    readonly type: HandleType;

    /**
     * Human-readable description.
     *
     * WHY: Used in error messages, debugging output, and process listings
     * (e.g., lsof). Should identify what this handle represents.
     *
     * EXAMPLES:
     * - File: "/home/user/file.txt"
     * - Socket: "tcp://192.168.1.1:8080"
     * - Pipe: "pipe:12345"
     * - Console: "/dev/console (stdout)"
     *
     * INVARIANT: Non-empty string.
     */
    readonly description: string;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether the handle is closed.
     *
     * WHY: Provides fast-path check without async call. Allows kernel to
     * skip exec() entirely if handle is already closed.
     *
     * INVARIANT: Once true, never becomes false again.
     */
    readonly closed: boolean;

    // =========================================================================
    // OPERATIONS
    // =========================================================================

    /**
     * Execute a message operation on this handle.
     *
     * Named exec() to avoid collision with msg.op = 'send'.
     *
     * ALGORITHM:
     * 1. Validate msg structure
     * 2. Check closed state
     * 3. Dispatch based on msg.op
     * 4. Yield Response messages
     * 5. Always yield at least one Response (even if error)
     *
     * COMMON OPERATIONS (handle-dependent):
     * - recv: Read/receive data
     * - send: Write/send data
     * - open: Open sub-resource
     * - close: Close sub-resource
     * - seek: Change position (file handles)
     * - connect: Establish connection (socket handles)
     * - accept: Accept connection (socket handles)
     *
     * RACE CONDITION:
     * Multiple processes may call exec() concurrently. Handle implementations
     * must either serialize operations or support concurrent access safely.
     * The caller will iterate the returned AsyncIterable and may stop at any
     * time (e.g., if process is killed).
     *
     * ERROR HANDLING:
     * - Unknown operations should yield respond.error('EINVAL', 'Unknown op')
     * - Closed handles should yield respond.error('EBADF', 'Handle closed')
     * - Operation-specific errors use appropriate POSIX error codes
     * - Must not throw exceptions - always yield error responses
     *
     * @param msg - Message containing operation (msg.op) and data (msg.data)
     * @returns Async iterable of responses (must yield at least one)
     */
    exec(msg: Message): AsyncIterable<Response>;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close the handle and release resources.
     *
     * ALGORITHM:
     * 1. Set closed=true
     * 2. Release resources (file descriptors, network connections, etc.)
     * 3. Cancel pending operations (best-effort)
     *
     * INVARIANTS:
     * - Must be idempotent (safe to call multiple times)
     * - After close(), closed must be true
     * - After close(), exec() must fail with EBADF
     *
     * RACE CONDITION:
     * close() may be called while exec() is running. Implementations should:
     * - Set closed flag first (stops new operations)
     * - Allow in-flight operations to complete or fail gracefully
     * - Release resources last (prevents use-after-free)
     *
     * ERROR HANDLING:
     * Should not throw exceptions. Log errors internally but always complete
     * successfully. This ensures process cleanup can't be blocked by failed
     * handle cleanup.
     *
     * @returns Promise that resolves when cleanup is complete
     */
    close(): Promise<void>;
}
