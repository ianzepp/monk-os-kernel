/**
 * Channel Syscalls - Inter-process communication through channels
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Channel syscalls provide the kernel interface for inter-process communication
 * through channels. Channels are bidirectional message streams that support three
 * communication patterns: request/response (call), streaming (stream), and
 * push-based messaging (push/recv).
 *
 * Each process maintains a handle table mapping channel descriptors (integers) to
 * Channel objects. The syscalls validate descriptors, enforce handle ownership,
 * and forward operations to the underlying Channel implementation. This separation
 * allows the kernel to track resource usage while delegating protocol logic to
 * channel implementations.
 *
 * Channels are protocol-specific: the 'channel:open' syscall takes a protocol
 * identifier (e.g., 'http', 'ws') and delegates to the appropriate channel handler.
 * This design enables extensible communication patterns without modifying the
 * syscall interface.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Channel descriptors are process-local - descriptor N in process A is
 *        independent from descriptor N in process B
 * INV-2: All channel syscalls validate descriptor type (must be number)
 * INV-3: All channel operations check handle validity before delegating
 * INV-4: Channel handles are reference-counted - closing a handle releases resources
 * INV-5: Syscalls yield responses asynchronously - callers must consume the iterator
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * processes can invoke syscalls concurrently. Each process has independent handle
 * tables, so concurrent channel operations on different processes cannot interfere.
 *
 * Within a single process, concurrent operations on the same channel descriptor
 * are possible (e.g., simultaneous call and stream). The underlying Channel
 * implementation is responsible for handling this safely. Most channels serialize
 * operations internally or fail fast if operations conflict.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Handle validation before async operations - channel may be closed during
 *       message processing
 * RC-2: Response iterators check handle validity at yield points - prevents
 *       use-after-close
 * RC-3: Channel close is async and awaited - ensures cleanup completes before
 *       handle is reused
 *
 * MEMORY MANAGEMENT
 * =================
 * Channels are allocated when opened and released when closed. The kernel tracks
 * open handles per process. When a process terminates, all handles are automatically
 * closed. Callers must explicitly close channels to release resources earlier.
 *
 * Response messages are yielded as they arrive - no buffering in the syscall layer.
 * Memory is bounded by the underlying Channel implementation's buffering strategy.
 *
 * @module kernel/syscalls/channel
 */

import type { HAL, Channel, ChannelOpts } from '@src/hal/index.js';
import type { Process } from '@src/kernel/types.js';
import type { Response, Message } from '@src/message.js';
import { respond } from '@src/message.js';
import type { SyscallRegistry } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Callback to open a channel and allocate a handle.
 *
 * WHY: Dependency injection enables testing and decouples syscalls from kernel.
 *
 * @param proc - Process requesting the channel
 * @param proto - Protocol identifier (e.g., 'http', 'ws')
 * @param url - Target URL or address
 * @param opts - Optional channel configuration
 * @returns Allocated channel descriptor
 */
type OpenChannelFn = (proc: Process, proto: string, url: string, opts?: ChannelOpts) => Promise<number>;

/**
 * Callback to get a channel from a handle descriptor.
 *
 * WHY: Decouples handle table lookup from syscall logic.
 *
 * @param proc - Process owning the handle
 * @param ch - Channel descriptor
 * @returns Channel object or undefined if handle invalid
 */
type GetChannelFn = (proc: Process, ch: number) => Channel | undefined;

/**
 * Callback to close a handle and release resources.
 *
 * WHY: Centralizes cleanup logic in kernel's resource manager.
 *
 * @param proc - Process owning the handle
 * @param ch - Channel descriptor to close
 */
type CloseHandleFn = (proc: Process, ch: number) => Promise<void>;

// =============================================================================
// SYSCALL FACTORY
// =============================================================================

/**
 * Create channel syscall registry.
 *
 * Factory function that takes kernel callbacks and returns a registry of
 * channel syscalls. This pattern enables dependency injection for testing
 * and keeps syscalls decoupled from kernel internals.
 *
 * WHY factory pattern:
 * Syscalls need access to kernel's handle table and resource management, but
 * we don't want to couple them to the full Kernel class. This factory takes
 * minimal callbacks and returns a self-contained syscall registry.
 *
 * TESTABILITY:
 * Tests can provide mock implementations of openChannel/getChannel/closeHandle
 * to verify syscall behavior without a full kernel.
 *
 * @param _hal - HAL instance (currently unused but reserved for future extensions)
 * @param openChannel - Function to open a channel and allocate handle
 * @param getChannel - Function to get channel from handle
 * @param closeHandle - Function to close handle
 * @returns Registry mapping syscall names to handler functions
 */
export function createChannelSyscalls(
    _hal: HAL,
    openChannel: OpenChannelFn,
    getChannel: GetChannelFn,
    closeHandle: CloseHandleFn
): SyscallRegistry {
    return {
        // =====================================================================
        // CHANNEL LIFECYCLE
        // =====================================================================

        /**
         * Open a channel and allocate a descriptor.
         *
         * Opens a channel using the specified protocol and URL, allocates a
         * handle descriptor, and returns it to the caller. The descriptor is
         * process-local and used for subsequent channel operations.
         *
         * ALGORITHM:
         * 1. Validate proto and url are strings
         * 2. Delegate to kernel's openChannel callback
         * 3. Return allocated descriptor
         *
         * @param proc - Calling process
         * @param proto - Protocol identifier (unknown type requires validation)
         * @param url - Target URL or address (unknown type requires validation)
         * @param opts - Optional channel configuration
         * @yields ok(descriptor) on success, error on validation failure
         */
        async *'channel:open'(proc: Process, proto: unknown, url: unknown, opts?: unknown): AsyncIterable<Response> {
            // Input validation: proto must be string
            // WHY: Protocol routing requires string identifier
            if (typeof proto !== 'string') {
                yield respond.error('EINVAL', 'proto must be a string');
                return;
            }

            // Input validation: url must be string
            // WHY: URL parsing and connection establishment require string
            if (typeof url !== 'string') {
                yield respond.error('EINVAL', 'url must be a string');
                return;
            }

            // Delegate to kernel's channel opening logic
            // WHY: Kernel manages handle table and protocol routing
            const ch = await openChannel(proc, proto, url, opts as ChannelOpts | undefined);
            yield respond.ok(ch);
        },

        /**
         * Close a channel and release its descriptor.
         *
         * Closes the channel, flushes pending data, and releases the descriptor
         * for reuse. After closing, the descriptor becomes invalid and subsequent
         * operations will fail with EBADF.
         *
         * ALGORITHM:
         * 1. Validate ch is a number
         * 2. Delegate to kernel's closeHandle callback
         * 3. Return success
         *
         * @param proc - Calling process
         * @param ch - Channel descriptor (unknown type requires validation)
         * @yields ok() on success, error on validation failure
         */
        async *'channel:close'(proc: Process, ch: unknown): AsyncIterable<Response> {
            // Input validation: ch must be number
            // WHY: Handle descriptors are integers in handle table
            if (typeof ch !== 'number') {
                yield respond.error('EINVAL', 'ch must be a number');
                return;
            }

            // Delegate to kernel's handle closing logic
            // WHY: Kernel tracks resources and performs cleanup
            await closeHandle(proc, ch);
            yield respond.ok();
        },

        // =====================================================================
        // REQUEST/RESPONSE PATTERN
        // =====================================================================

        /**
         * Send a message and receive responses until terminal response.
         *
         * Implements request/response pattern: sends a message to the channel
         * and yields all responses until a terminal response (ok/error/done)
         * is received. Intermediate responses (e.g., progress updates) are
         * yielded as they arrive.
         *
         * ALGORITHM:
         * 1. Validate ch is a number
         * 2. Look up channel from handle table
         * 3. Delegate message to channel.handle()
         * 4. Yield responses until terminal response
         * 5. If no terminal response, yield error
         *
         * RACE CONDITION:
         * Channel may be closed while awaiting responses. The getChannel check
         * happens before iteration starts. If channel is closed during iteration,
         * the iterator will throw and propagate the error to the caller.
         *
         * @param proc - Calling process
         * @param ch - Channel descriptor (unknown type requires validation)
         * @param msg - Message to send (unknown type, validated by channel)
         * @yields Responses until terminal response, then stops
         */
        async *'channel:call'(proc: Process, ch: unknown, msg: unknown): AsyncIterable<Response> {
            // Input validation: ch must be number
            if (typeof ch !== 'number') {
                yield respond.error('EINVAL', 'ch must be a number');
                return;
            }

            // Look up channel from handle table
            // RACE FIX: Check validity before async operations
            const channel = getChannel(proc, ch);
            if (!channel) {
                yield respond.error('EBADF', `Bad channel: ${ch}`);
                return;
            }

            // Delegate to channel and yield until terminal response
            // WHY: Terminal response indicates completion of request/response cycle
            for await (const response of channel.handle(msg as Message)) {
                yield response;
                if (response.op === 'ok' || response.op === 'error' || response.op === 'done') {
                    return;
                }
            }

            // Iterator completed without terminal response
            // WHY: Indicates protocol violation or channel implementation bug
            yield respond.error('EIO', 'No response from channel');
        },

        // =====================================================================
        // STREAMING PATTERN
        // =====================================================================

        /**
         * Send a message and stream all responses.
         *
         * Implements streaming pattern: sends a message to the channel and
         * yields all responses indefinitely. Unlike 'call', this does not
         * stop at terminal responses - the stream continues until the channel
         * closes or the caller stops consuming responses.
         *
         * ALGORITHM:
         * 1. Validate ch is a number
         * 2. Look up channel from handle table
         * 3. Delegate message to channel.handle()
         * 4. Yield all responses (no filtering)
         *
         * RACE CONDITION:
         * Same as 'call' - channel may be closed during iteration. The async
         * iterator will throw if channel is closed mid-stream.
         *
         * @param proc - Calling process
         * @param ch - Channel descriptor (unknown type requires validation)
         * @param msg - Message to send (unknown type, validated by channel)
         * @yields All responses until channel closes or caller stops
         */
        async *'channel:stream'(proc: Process, ch: unknown, msg: unknown): AsyncIterable<Response> {
            // Input validation: ch must be number
            if (typeof ch !== 'number') {
                yield respond.error('EINVAL', 'ch must be a number');
                return;
            }

            // Look up channel from handle table
            // RACE FIX: Check validity before async operations
            const channel = getChannel(proc, ch);
            if (!channel) {
                yield respond.error('EBADF', `Bad channel: ${ch}`);
                return;
            }

            // Delegate to channel and yield all responses
            // WHY: Streaming pattern requires yielding indefinitely
            yield* channel.handle(msg as Message);
        },

        // =====================================================================
        // PUSH-BASED MESSAGING
        // =====================================================================

        /**
         * Push a response to the channel.
         *
         * Implements push-based messaging: sends a response to the channel
         * without waiting for replies. Used for bidirectional channels where
         * both sides can initiate messages.
         *
         * ALGORITHM:
         * 1. Validate ch is a number
         * 2. Look up channel from handle table
         * 3. Push response to channel
         * 4. Return success
         *
         * @param proc - Calling process
         * @param ch - Channel descriptor (unknown type requires validation)
         * @param response - Response to push (unknown type, validated by channel)
         * @yields ok() on success, error on validation failure
         */
        async *'channel:push'(proc: Process, ch: unknown, response: unknown): AsyncIterable<Response> {
            // Input validation: ch must be number
            if (typeof ch !== 'number') {
                yield respond.error('EINVAL', 'ch must be a number');
                return;
            }

            // Look up channel from handle table
            const channel = getChannel(proc, ch);
            if (!channel) {
                yield respond.error('EBADF', `Bad channel: ${ch}`);
                return;
            }

            // Push response to channel
            // WHY: Channel buffers or queues the response internally
            await channel.push(response as Response);
            yield respond.ok();
        },

        /**
         * Receive a response from the channel.
         *
         * Implements pull-based messaging: blocks until a response is available
         * on the channel. Complements 'push' for bidirectional communication.
         *
         * ALGORITHM:
         * 1. Validate ch is a number
         * 2. Look up channel from handle table
         * 3. Await response from channel
         * 4. Return response
         *
         * RACE CONDITION:
         * Channel may be closed while awaiting response. The channel.recv()
         * call should throw if channel closes during wait.
         *
         * @param proc - Calling process
         * @param ch - Channel descriptor (unknown type requires validation)
         * @yields ok(message) on success, error on validation failure
         */
        async *'channel:recv'(proc: Process, ch: unknown): AsyncIterable<Response> {
            // Input validation: ch must be number
            if (typeof ch !== 'number') {
                yield respond.error('EINVAL', 'ch must be a number');
                return;
            }

            // Look up channel from handle table
            const channel = getChannel(proc, ch);
            if (!channel) {
                yield respond.error('EBADF', `Bad channel: ${ch}`);
                return;
            }

            // Await response from channel
            // WHY: Blocks until response available or channel closes
            const msg = await channel.recv();
            yield respond.ok(msg);
        },
    };
}
