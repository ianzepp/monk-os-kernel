/**
 * Network Syscalls - Network communication primitives
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Network syscalls provide kernel-level primitives for TCP connections, Unix
 * sockets, and message-passing ports. They bridge userspace processes with
 * HAL's network stack while enforcing handle-based resource management.
 *
 * The syscalls support three abstractions:
 * 1. Connections (TCP/Unix) - Stream-oriented bidirectional sockets for
 *    reliable byte streams. Allocated via 'connect', read/written via file
 *    handle operations, closed via handle close.
 * 2. Ports - Message-passing endpoints for process-to-process communication.
 *    Support both local (same machine) and remote (network) messaging.
 * 3. Port messages - Structured message exchange through ports, with automatic
 *    handle allocation for incoming connections.
 *
 * Handle management is unified: both sockets and ports use the same handle
 * table and cleanup mechanism. This simplifies resource tracking and ensures
 * consistent teardown on process exit.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Handle descriptors are process-local - descriptor N in process A is
 *        independent from descriptor N in process B
 * INV-2: All network syscalls validate argument types before operations
 * INV-3: Handle validity is checked before delegating operations
 * INV-4: Port message reception auto-allocates handles for incoming sockets
 * INV-5: All syscalls yield responses asynchronously - callers must consume iterator
 * INV-6: Protocol strings determine connection type (tcp/unix)
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * processes can invoke syscalls concurrently. Each process has independent
 * handle tables, preventing cross-process interference.
 *
 * Within a single process, concurrent operations on the same port are possible
 * (e.g., simultaneous send/recv). Port implementations serialize operations
 * internally or use queue-based buffering to handle this safely.
 *
 * TCP sockets are stream-oriented and assume sequential access - concurrent
 * read/write operations on the same socket may produce undefined ordering.
 * Callers should serialize socket I/O at application level.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Handle validation before async operations - port/socket may be closed
 *       during message processing
 * RC-2: Port recv auto-allocates handles atomically - prevents handle reuse races
 * RC-3: Port send validates recipient before transmission - prevents send-to-closed
 * RC-4: Connection establishment is atomic - either succeeds with valid handle
 *       or fails cleanly
 *
 * MEMORY MANAGEMENT
 * =================
 * Sockets and ports are allocated on creation and released on close. The kernel
 * tracks open handles per process. When a process terminates, all handles are
 * automatically closed.
 *
 * Port message buffers are managed by the underlying Port implementation. The
 * syscall layer does not buffer - messages are passed directly. Memory is
 * bounded by the Port's internal queue size and backpressure mechanisms.
 *
 * @module kernel/syscalls/network
 */

import type { HAL } from '@src/hal/index.js';
import type { Process } from '@src/kernel/types.js';
import type { Port } from '@src/kernel/resource.js';
import type { Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { SyscallRegistry, ProcessPortMessage } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Callback to connect TCP and allocate a socket handle.
 *
 * WHY: Dependency injection enables testing and decouples syscalls from kernel.
 *
 * @param proc - Process requesting the connection
 * @param host - Hostname or IP address
 * @param port - Port number (0 for Unix sockets)
 * @returns Allocated socket descriptor
 */
type ConnectTcpFn = (proc: Process, host: string, port: number) => Promise<number>;

/**
 * Callback to create a port and allocate a handle.
 *
 * WHY: Decouples port creation from syscall logic.
 *
 * @param proc - Process requesting the port
 * @param type - Port type identifier (e.g., 'tcp', 'udp', 'local')
 * @param opts - Port configuration options
 * @returns Allocated port descriptor
 */
type CreatePortFn = (proc: Process, type: string, opts: unknown) => Promise<number>;

/**
 * Callback to get a port from a handle descriptor.
 *
 * WHY: Decouples handle table lookup from syscall logic.
 *
 * @param proc - Process owning the handle
 * @param h - Port descriptor
 * @returns Port object or undefined if handle invalid
 */
type GetPortFn = (proc: Process, h: number) => Port | undefined;

/**
 * Callback to receive from a port with auto-handle allocation.
 *
 * WHY: Centralizes handle allocation for incoming connections in kernel.
 *
 * @param proc - Process owning the port
 * @param h - Port descriptor
 * @returns Message with sender and optional socket handle
 */
type RecvPortFn = (proc: Process, h: number) => Promise<ProcessPortMessage>;

/**
 * Callback to close a handle and release resources.
 *
 * WHY: Centralizes cleanup logic in kernel's resource manager.
 *
 * @param proc - Process owning the handle
 * @param h - Handle descriptor to close
 */
type CloseHandleFn = (proc: Process, h: number) => Promise<void>;

// =============================================================================
// SYSCALL FACTORY
// =============================================================================

/**
 * Create network syscall registry.
 *
 * Factory function that takes kernel callbacks and returns a registry of
 * network syscalls. This pattern enables dependency injection for testing
 * and keeps syscalls decoupled from kernel internals.
 *
 * WHY factory pattern:
 * Syscalls need access to kernel's handle table and resource management, but
 * we don't want to couple them to the full Kernel class. This factory takes
 * minimal callbacks and returns a self-contained syscall registry.
 *
 * TESTABILITY:
 * Tests can provide mock implementations of connectTcp/createPort/getPort/etc
 * to verify syscall behavior without a full kernel or network stack.
 *
 * @param _hal - HAL instance (currently unused but reserved for future extensions)
 * @param connectTcp - Function to connect and allocate fd for socket
 * @param createPort - Function to create a port and allocate handle
 * @param getPort - Function to get port from handle
 * @param recvPort - Function to receive from port (auto-allocates handle for sockets)
 * @param closeHandle - Function to close handle
 * @returns Registry mapping syscall names to handler functions
 */
export function createNetworkSyscalls(
    _hal: HAL,
    connectTcp: ConnectTcpFn,
    createPort: CreatePortFn,
    getPort: GetPortFn,
    recvPort: RecvPortFn,
    closeHandle: CloseHandleFn
): SyscallRegistry {
    return {
        // =====================================================================
        // CONNECTION ESTABLISHMENT
        // =====================================================================

        /**
         * Connect to a remote endpoint and allocate a socket descriptor.
         *
         * Establishes a connection using the specified protocol (tcp/unix) and
         * returns a file descriptor for the socket. The socket can then be used
         * with standard file operations (read/write/close).
         *
         * ALGORITHM:
         * 1. Validate proto, host, and port types
         * 2. Switch on protocol type
         * 3. For TCP: validate port number and connect
         * 4. For Unix: use host as path, port=0
         * 5. Return allocated descriptor
         *
         * WHY Unix sockets use port=0:
         * Unix domain sockets are identified by filesystem paths (stored in
         * host parameter). The port parameter is unused but required by the
         * connectTcp signature, so we pass 0 as a sentinel.
         *
         * @param proc - Calling process
         * @param proto - Protocol identifier (unknown type requires validation)
         * @param host - Hostname/IP/path (unknown type requires validation)
         * @param port - Port number for TCP (unknown type requires validation)
         * @yields ok(descriptor) on success, error on validation/connection failure
         */
        async *'net:connect'(proc: Process, proto: unknown, host: unknown, port: unknown): AsyncIterable<Response> {
            // Input validation: proto must be string
            // WHY: Protocol routing requires string identifier
            if (typeof proto !== 'string') {
                yield respond.error('EINVAL', 'proto must be a string');
                return;
            }

            // Input validation: host must be string
            // WHY: DNS resolution and path lookup require string
            if (typeof host !== 'string') {
                yield respond.error('EINVAL', 'host must be a string');
                return;
            }

            // Protocol-specific connection establishment
            switch (proto) {
                case 'tcp':
                    // TCP requires numeric port
                    // WHY: Port numbers are 16-bit integers (0-65535)
                    if (typeof port !== 'number') {
                        yield respond.error('EINVAL', 'port must be a number');
                        return;
                    }
                    yield respond.ok(await connectTcp(proc, host, port));
                    return;

                case 'unix':
                    // Unix sockets use filesystem path (host) instead of port
                    // WHY: Unix domain sockets are identified by paths
                    yield respond.ok(await connectTcp(proc, host, 0));
                    return;

                default:
                    // Unsupported protocol
                    // WHY: Prevents typos and documents supported protocols
                    yield respond.error('EINVAL', `unsupported protocol: ${proto}`);
            }
        },

        // =====================================================================
        // PORT LIFECYCLE
        // =====================================================================

        /**
         * Create a port for message-passing communication.
         *
         * Creates a port of the specified type and returns a descriptor. Ports
         * support bidirectional message exchange with automatic handle allocation
         * for incoming connections.
         *
         * ALGORITHM:
         * 1. Validate type is a string
         * 2. Delegate to kernel's createPort callback
         * 3. Return allocated descriptor
         *
         * @param proc - Calling process
         * @param type - Port type identifier (unknown type requires validation)
         * @param opts - Port configuration options (type validation delegated)
         * @yields ok(descriptor) on success, error on validation failure
         */
        async *'port:create'(proc: Process, type: unknown, opts: unknown): AsyncIterable<Response> {
            // Input validation: type must be string
            // WHY: Port type routing requires string identifier
            if (typeof type !== 'string') {
                yield respond.error('EINVAL', 'type must be a string');
                return;
            }

            // Delegate to kernel's port creation logic
            // WHY: Kernel manages handle table and port type routing
            const portId = await createPort(proc, type, opts);
            yield respond.ok(portId);
        },

        /**
         * Close a port and release its descriptor.
         *
         * Closes the port, flushes pending messages, and releases the descriptor
         * for reuse. After closing, the descriptor becomes invalid and subsequent
         * operations will fail with EBADF.
         *
         * ALGORITHM:
         * 1. Validate portId is a number
         * 2. Delegate to kernel's closeHandle callback
         * 3. Return success
         *
         * @param proc - Calling process
         * @param portId - Port descriptor (unknown type requires validation)
         * @yields ok() on success, error on validation failure
         */
        async *'port:close'(proc: Process, portId: unknown): AsyncIterable<Response> {
            // Input validation: portId must be number
            // WHY: Handle descriptors are integers in handle table
            if (typeof portId !== 'number') {
                yield respond.error('EINVAL', 'portId must be a number');
                return;
            }

            // Delegate to kernel's handle closing logic
            // WHY: Kernel tracks resources and performs cleanup
            await closeHandle(proc, portId);
            yield respond.ok();
        },

        // =====================================================================
        // PORT MESSAGE PASSING
        // =====================================================================

        /**
         * Receive a message from a port.
         *
         * Blocks until a message is available on the port. If the message includes
         * an incoming socket connection, a handle is automatically allocated and
         * included in the response.
         *
         * ALGORITHM:
         * 1. Validate portId is a number
         * 2. Look up port from handle table
         * 3. Await message from port (blocks if queue empty)
         * 4. Auto-allocate handle for incoming socket if present
         * 5. Return message with sender and optional socket handle
         *
         * RACE CONDITION:
         * Port may be closed while awaiting message. The recvPort callback
         * should throw if port closes during wait. The handle validity check
         * happens before blocking on recv.
         *
         * WHY auto-allocate handles:
         * Incoming socket connections require handle descriptors. Doing this
         * automatically in the kernel simplifies userspace code and ensures
         * handles are properly tracked for cleanup.
         *
         * @param proc - Calling process
         * @param portId - Port descriptor (unknown type requires validation)
         * @yields ok(message) on success, error on validation failure
         */
        async *'port:recv'(proc: Process, portId: unknown): AsyncIterable<Response> {
            // Input validation: portId must be number
            if (typeof portId !== 'number') {
                yield respond.error('EINVAL', 'portId must be a number');
                return;
            }

            // Look up port from handle table
            // RACE FIX: Check validity before async operations
            const port = getPort(proc, portId);
            if (!port) {
                yield respond.error('EBADF', `Bad port: ${portId}`);
                return;
            }

            // Await message from port with auto-handle allocation
            // WHY: Blocks until message available or port closes
            const msg = await recvPort(proc, portId);
            yield respond.ok(msg);
        },

        /**
         * Send a message to a port.
         *
         * Sends data to the specified recipient via the port. The recipient is
         * identified by a string address (interpretation depends on port type).
         *
         * ALGORITHM:
         * 1. Validate portId, to, and data types
         * 2. Look up port from handle table
         * 3. Send data to recipient via port
         * 4. Return success
         *
         * WHY data must be Uint8Array:
         * Network transmission requires binary data. Uint8Array provides zero-copy
         * transfer to HAL's network stack. String encoding/decoding is caller's
         * responsibility.
         *
         * @param proc - Calling process
         * @param portId - Port descriptor (unknown type requires validation)
         * @param to - Recipient address (unknown type requires validation)
         * @param data - Binary data to send (unknown type requires validation)
         * @yields ok() on success, error on validation failure
         */
        async *'port:send'(proc: Process, portId: unknown, to: unknown, data: unknown): AsyncIterable<Response> {
            // Input validation: portId must be number
            if (typeof portId !== 'number') {
                yield respond.error('EINVAL', 'portId must be a number');
                return;
            }

            // Input validation: to must be string
            // WHY: Recipient addresses are string identifiers
            if (typeof to !== 'string') {
                yield respond.error('EINVAL', 'to must be a string');
                return;
            }

            // Input validation: data must be Uint8Array
            // WHY: Network transmission requires binary data
            if (!(data instanceof Uint8Array)) {
                yield respond.error('EINVAL', 'data must be Uint8Array');
                return;
            }

            // Look up port from handle table
            const port = getPort(proc, portId);
            if (!port) {
                yield respond.error('EBADF', `Bad port: ${portId}`);
                return;
            }

            // Send data to recipient via port
            // WHY: Port handles addressing and transmission internally
            await port.send(to, data);
            yield respond.ok();
        },
    };
}
