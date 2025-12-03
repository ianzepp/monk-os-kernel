/**
 * Syscall Types - Type definitions for syscall handlers and messages
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines the core interfaces for the Monk OS syscall system. Syscalls
 * are the bridge between user processes and kernel services, implementing the same
 * request/response pattern as IPC but with kernel privileges.
 *
 * Syscall handlers are async generators that yield Response objects. This streaming
 * design enables both single-value returns (yield respond.ok(value)) and collection
 * streaming (yield respond.item(x) per item, then respond.done()). The generator
 * pattern allows handlers to be interrupted or cancelled while processing.
 *
 * ProcessPortMessage defines the structure for port-based event delivery. Ports
 * provide a unified interface for async I/O events from different sources (TCP
 * connections, UDP packets, pubsub messages, file watches). The port abstraction
 * decouples event sources from process message handling.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: SyscallHandler always receives a valid Process as first parameter
 * INV-2: Handler args after Process must match the syscall signature
 * INV-3: Handlers must yield at least one Response before completion
 * INV-4: ProcessPortMessage.from is always a valid event source identifier
 * INV-5: ProcessPortMessage has exactly one of: fd, data, or meta.data
 *
 * CONCURRENCY MODEL
 * =================
 * Syscall handlers run in the kernel's async context, not the process's worker
 * thread. Multiple syscalls from different processes can execute concurrently and
 * interleave at await points. Handlers MUST check process state after every await
 * to ensure the process hasn't been killed or suspended.
 *
 * The Process object passed to handlers is shared state. Handlers should treat it
 * as read-only except when using kernel-provided mutation methods (setstate, etc).
 * Direct mutation can corrupt process state.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Process state validation after every await in handlers
 * RC-2: Port message delivery is fire-and-forget (no ACK) to avoid deadlock
 * RC-3: Syscall cancellation on process termination prevents resource leaks
 *
 * MEMORY MANAGEMENT
 * =================
 * - Handler args are deserialized from IPC messages (garbage collected)
 * - ProcessPortMessage objects are created per event (short-lived)
 * - Response objects yielded by handlers are immediately sent and GC'd
 * - No explicit cleanup required - all state is ephemeral
 *
 * @module kernel/syscalls/types
 */

import type { Process } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Syscall handler function type.
 *
 * All syscall implementations must match this signature. Handlers receive the
 * calling process and zero or more typed arguments, then yield Response objects
 * to send data back to the process.
 *
 * WHY async generator:
 * The generator pattern allows handlers to yield multiple values (streaming),
 * be cancelled mid-execution (process killed), and suspend/resume naturally
 * via async/await. This is more flexible than Promise<Response[]>.
 *
 * WHY unknown[] args:
 * Syscalls have heterogeneous signatures. Type safety is enforced at the
 * syscall implementation level, not at this interface level. This enables
 * a unified registry type.
 *
 * INVARIANT: Must yield at least one Response before completion.
 *
 * @param proc - The calling process (for state, handles, permissions)
 * @param args - Syscall-specific arguments (type-checked by implementation)
 * @yields Response objects (respond.ok, respond.item, respond.done, respond.error)
 *
 * @example Single-value syscall
 * ```typescript
 * async function* getpid(proc: Process): AsyncIterable<Response> {
 *   yield respond.ok(proc.pid);
 * }
 * ```
 *
 * @example Collection-streaming syscall
 * ```typescript
 * async function* readdir(proc: Process, path: string): AsyncIterable<Response> {
 *   for await (const entry of entries) {
 *     // RACE FIX: Check process state after every await
 *     if (proc.state !== 'running') return;
 *     yield respond.item(entry);
 *   }
 *   yield respond.done();
 * }
 * ```
 */
export type SyscallHandler = (
    proc: Process,
    ...args: unknown[]
) => AsyncIterable<Response>;

/**
 * Syscall registry mapping syscall names to handlers.
 *
 * WHY string index signature:
 * Allows dynamic syscall registration and lookup at runtime. Syscalls are
 * registered by name during kernel initialization and dispatched by name
 * on process requests.
 *
 * TESTABILITY: Exported interface allows test mocks to provide custom handlers.
 *
 * @example
 * ```typescript
 * const registry: SyscallRegistry = {
 *   'fs:open': createFileSyscalls().open,
 *   'fs:read': createFileSyscalls().read,
 *   'net:connect': createNetworkSyscalls().connect,
 * };
 * ```
 */
export interface SyscallRegistry {
    [name: string]: SyscallHandler;
}

/**
 * Port message delivered to a process's port.
 *
 * Ports provide async event delivery from I/O sources. When an event occurs
 * (TCP connection accepted, UDP packet received, file change detected), the
 * kernel creates a ProcessPortMessage and posts it to the process's worker.
 *
 * WHY union of fd/data/meta:
 * Different event types carry different payloads. TCP accepts return a file
 * descriptor for the new connection. UDP/pubsub/watch return data bytes.
 * The discriminated union avoids runtime type checks.
 *
 * INVARIANT: Exactly one of fd, data, or meta.data must be present.
 *
 * @example TCP accept
 * ```typescript
 * { from: 'tcp:3000', fd: 5 }
 * ```
 *
 * @example UDP packet
 * ```typescript
 * { from: 'udp:3000', data: new Uint8Array([...]) }
 * ```
 *
 * @example File watch
 * ```typescript
 * { from: 'watch:/path', data: encoder.encode('{"op":"update"}'), meta: { path: '/path' } }
 * ```
 */
export interface ProcessPortMessage {
    /**
     * Source identifier for the event.
     *
     * WHY: Allows process to distinguish which port triggered the message.
     * Format: "{protocol}:{address}" (e.g., "tcp:3000", "udp:8080", "watch:/etc")
     *
     * INVARIANT: Always present and non-empty.
     */
    from: string;

    /**
     * File descriptor for accepted TCP connections.
     *
     * WHY: TCP listen ports return a new fd for each accepted connection.
     * The process uses this fd for read/write syscalls.
     *
     * USAGE: Set only for tcp:listen ports. Undefined for other port types.
     */
    fd?: number;

    /**
     * Payload data for UDP, pubsub, and watch events.
     *
     * WHY: These event types carry binary or text data in their messages.
     * For watch events, this is typically JSON-encoded change metadata.
     *
     * USAGE: Set for udp, pubsub, watch ports. Undefined for tcp:listen.
     */
    data?: Uint8Array;

    /**
     * Optional metadata for events.
     *
     * WHY: Some events carry structured information beyond raw data. Watch
     * events include path, operation type, etc. This avoids forcing all
     * metadata into the data blob.
     *
     * USAGE: Populated by specific port implementations as needed.
     */
    meta?: Record<string, unknown>;
}
