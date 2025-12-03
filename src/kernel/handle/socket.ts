/**
 * Socket Handle Adapter - Wraps HAL Socket in the unified handle interface
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * SocketHandleAdapter bridges the HAL network socket abstraction with the
 * kernel's unified handle interface. It translates message-based operations
 * (recv/send/stat) into HAL Socket method calls, enabling processes to perform
 * network I/O through the same interface used for files, pipes, and other
 * I/O resources.
 *
 * The adapter wraps a HAL Socket and exposes it through the kernel's Handle
 * interface, which uses async generators to stream responses. This design
 * allows network I/O to be multiplexed with other operations and supports
 * streaming large responses without buffering everything in memory.
 *
 * Unlike file handles, sockets don't support seeking (no random access).
 * Socket handles support three operations:
 * - recv: Stream incoming data in chunks until connection closes
 * - send: Write data to socket
 * - stat: Get socket metadata (addresses, ports)
 *
 * WHY internal buffering:
 * HAL Socket.read() returns variable-sized chunks based on network packets.
 * The adapter buffers partial chunks to provide consistent chunk sizes to
 * the caller, which simplifies protocol parsing and reduces syscall overhead.
 *
 * STATE MACHINE
 * =============
 *
 *   new() ──────────> OPEN ──────────> CLOSED
 *                      │                  ^
 *                      │ (error/EOF)      │
 *                      └──────────────────┘
 *                            close()
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Once _closed is true, all operations yield EBADF error
 * INV-2: buffer contains leftover data from previous read that didn't fit
 * INV-3: recv() never yields more than MAX_STREAM_BYTES total
 * INV-4: _stat is immutable snapshot taken at construction time
 * INV-5: Handle ID is immutable and unique for entire handle lifetime
 * INV-6: Type is always 'socket' (never changes)
 *
 * CONCURRENCY MODEL
 * =================
 * Each SocketHandleAdapter instance wraps a single HAL Socket. The socket
 * represents a network connection with its own kernel-level buffers. Multiple
 * adapters should not wrap the same socket (undefined behavior).
 *
 * Operations are async and can interleave at await points. The adapter checks
 * the closed state at the start of each operation to prevent use-after-close.
 * Unlike file handles, there's no shared state between socket handles.
 *
 * The recv() operation streams chunks via async generator. Concurrent recv()
 * calls on the same handle would corrupt the internal buffer (undefined
 * behavior). Callers must ensure exclusive access to recv() operations.
 *
 * Send operations can be concurrent - they're queued by the underlying HAL
 * socket implementation. However, message ordering is only guaranteed within
 * a single send() call.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check _closed at operation entry - prevents ops after explicit close()
 * RC-2: recv() enforces MAX_STREAM_BYTES limit - prevents infinite read loops
 * RC-3: send() validates data type early - fails fast on invalid input
 * RC-4: Error catching in all operations - converts exceptions to error responses
 * RC-5: Internal buffer only modified by recv() - no concurrent access issues
 *
 * MEMORY MANAGEMENT
 * =================
 * - Adapter holds reference to HAL Socket until close()
 * - Internal buffer holds leftover data from previous read (typically small)
 * - Buffer size bounded by MAX_STREAM_BYTES enforcement
 * - _stat is cached on construction to avoid repeated HAL calls
 * - Handle cleanup responsibility lies with caller (should use await using)
 * - Close is idempotent - safe to call multiple times
 *
 * @module kernel/handle/socket
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Socket } from '@src/hal/network.js';
import { DEFAULT_CHUNK_SIZE, MAX_STREAM_BYTES } from '@src/kernel/types.js';
import type { Handle, HandleType } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * SocketHandleAdapter - Wraps HAL Socket in unified handle interface.
 *
 * Bridges message-based kernel operations with HAL socket I/O methods.
 * Supports streaming reads with buffering, writes, and metadata queries.
 */
export class SocketHandleAdapter implements Handle {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Handle type identifier.
     *
     * WHY: Enables handle type discrimination at runtime.
     * INVARIANT: Always 'socket' (never changes).
     */
    readonly type: HandleType = 'socket';

    /**
     * Unique handle identifier.
     *
     * WHY: Allows kernel to track and revoke handles by ID.
     * INVARIANT: Immutable and unique for entire handle lifetime.
     */
    readonly id: string;

    /**
     * Human-readable handle description.
     *
     * WHY: Used in logging and debugging to identify which connection.
     * Typically includes remote address/port.
     * INVARIANT: Immutable after construction.
     */
    readonly description: string;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Local closure flag.
     *
     * WHY: Tracks explicit close() calls on this adapter.
     * INVARIANT: Once true, never becomes false again.
     */
    private _closed = false;

    /**
     * Internal buffer for partial chunks.
     *
     * WHY: HAL Socket.read() returns variable-sized chunks (network packets).
     * We buffer partial data to provide consistent chunk sizes to caller.
     *
     * INVARIANT: Contains leftover bytes from previous read that exceeded
     * requested chunk size. Always empty at start of recv() operation.
     *
     * RACE CONDITION: Only modified by recv() - caller must not call recv()
     * concurrently on same handle.
     */
    private buffer: Uint8Array = new Uint8Array(0);

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Underlying HAL socket.
     *
     * WHY: Provides actual network I/O operations (read/write/close).
     * Socket state is managed by HAL - we only track our closure state.
     */
    private socket: Socket;

    /**
     * Cached socket metadata.
     *
     * WHY: Socket addresses/ports don't change after connection established.
     * Caching avoids repeated HAL calls and ensures consistent values even
     * if HAL implementation has bugs.
     *
     * INVARIANT: Immutable snapshot taken at construction time.
     */
    private readonly _stat: {
        remoteAddr: string;
        remotePort: number;
        localAddr: string;
        localPort: number;
    };

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new SocketHandleAdapter.
     *
     * WHY cache stat on construction:
     * Socket metadata is immutable after connection. Caching avoids HAL
     * calls on every stat() operation.
     *
     * @param id - Unique handle identifier
     * @param socket - HAL Socket to wrap
     * @param description - Human-readable connection description
     */
    constructor(id: string, socket: Socket, description: string) {
        this.id = id;
        this.socket = socket;
        this.description = description;

        // Cache stat on construction - addresses/ports don't change
        this._stat = socket.stat();
    }

    // =========================================================================
    // ACCESSORS
    // =========================================================================

    /**
     * Check if handle is closed.
     *
     * WHY: Only checks local _closed flag, not underlying socket state.
     * Unlike file handles, socket closure is always explicit via close().
     *
     * @returns True if close() was called on this adapter
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // MESSAGE DISPATCH
    // =========================================================================

    /**
     * Execute a handle operation from a message.
     *
     * ALGORITHM:
     * 1. Check if handle is closed
     * 2. Extract operation and data from message
     * 3. Dispatch to appropriate private method
     * 4. Stream responses via async generator
     *
     * WHY async generator:
     * Allows streaming multi-part responses (e.g., network packets) without
     * buffering everything in memory. Caller can process responses as they
     * arrive or cancel early.
     *
     * RACE CONDITION:
     * Closed check at entry, but handle may close during operation if another
     * reference exists. Each operation method should handle socket errors.
     *
     * @param msg - Operation message with op name and data payload
     * @returns Async generator yielding response messages
     */
    async *exec(msg: Message): AsyncIterable<Response> {
        // RACE FIX: Check closure state before dispatch
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'recv':
                yield* this.recv(data?.chunkSize as number | undefined);
                break;

            case 'send':
                yield* this.send(data?.data as Uint8Array);
                break;

            case 'stat':
                // Fast path - return cached stat without async
                yield respond.ok(this._stat);
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    /**
     * Stream socket data in chunks until connection closes.
     *
     * ALGORITHM:
     * 1. Read chunks from socket in loop
     * 2. Buffer management for consistent chunk sizes
     * 3. Yield each chunk as data response
     * 4. Track total bytes to enforce limit
     * 5. Stop on EOF (zero-length read from socket)
     * 6. Yield done response on success
     *
     * WHY enforce MAX_STREAM_BYTES:
     * Prevents infinite reads from misbehaving peers or attacks.
     * Protects against memory exhaustion.
     *
     * WHY buffer management:
     * Socket reads return variable-sized chunks (network packets).
     * Buffering provides consistent chunk sizes for easier parsing.
     *
     * @param chunkSize - Bytes per chunk (default: DEFAULT_CHUNK_SIZE)
     * @returns Async generator yielding data chunks and done/error
     */
    private async *recv(chunkSize?: number): AsyncIterable<Response> {
        const size = chunkSize ?? DEFAULT_CHUNK_SIZE;
        let totalYielded = 0;

        try {
            while (true) {
                // Read chunk (may come from buffer or socket)
                const chunk = await this.readChunk(size);

                // EOF - connection closed by peer
                if (chunk.length === 0) {
                    break;
                }

                // Enforce stream size limit
                totalYielded += chunk.length;
                if (totalYielded > MAX_STREAM_BYTES) {
                    yield respond.error('EFBIG', `Read stream exceeded ${MAX_STREAM_BYTES} bytes`);
                    return;
                }

                yield respond.data(chunk);
            }

            yield respond.done();
        } catch (err) {
            // Catch socket errors (connection reset, timeout, etc.)
            yield respond.error('EIO', (err as Error).message);
        }
    }

    /**
     * Read a chunk from buffer or socket.
     *
     * ALGORITHM:
     * 1. If buffer has data, return from buffer first
     * 2. If buffer fits entirely, return all and clear buffer
     * 3. If buffer too large, return requested size and keep rest
     * 4. If buffer empty, read from socket
     * 5. If socket read fits, return it
     * 6. If socket read too large, return requested size and buffer rest
     *
     * WHY buffer management:
     * Socket reads are variable-sized. We provide consistent chunk sizes
     * by buffering leftovers. This reduces syscall overhead and simplifies
     * protocol parsing for callers.
     *
     * WHY zero-length indicates EOF:
     * HAL Socket.read() returns empty Uint8Array when connection closed.
     * We propagate this up to recv() which stops iteration.
     *
     * @param size - Requested chunk size
     * @returns Chunk of at most size bytes (empty on EOF)
     */
    private async readChunk(size: number): Promise<Uint8Array> {
        // If we have buffered data, return from buffer first
        if (this.buffer.length > 0) {
            if (size >= this.buffer.length) {
                // Requested size fits entire buffer - return all and clear
                const data = this.buffer;
                this.buffer = new Uint8Array(0);
                return data;
            }
            // Buffer larger than requested - return prefix, keep rest
            const data = this.buffer.slice(0, size);
            this.buffer = this.buffer.slice(size);
            return data;
        }

        // Buffer empty - read from socket
        const chunk = await this.socket.read();
        if (chunk.length === 0) {
            // EOF - connection closed
            return chunk;
        }

        // If chunk fits requested size, return it directly
        if (chunk.length <= size) {
            return chunk;
        }

        // Chunk larger than requested - return prefix, buffer rest
        // WHY: Provides consistent chunk sizes for protocol parsing
        this.buffer = chunk.slice(size);
        return chunk.slice(0, size);
    }

    // =========================================================================
    // WRITE OPERATIONS
    // =========================================================================

    /**
     * Write data to socket.
     *
     * WHY strict type checking:
     * Message data is untyped - must validate before passing to HAL.
     * Socket writes require Uint8Array. Invalid types would cause HAL
     * to throw unclear errors or corrupt data.
     *
     * @param data - Bytes to write (must be Uint8Array)
     * @returns Response with bytes written or error
     */
    private async *send(data: Uint8Array): AsyncIterable<Response> {
        if (!(data instanceof Uint8Array)) {
            yield respond.error('EINVAL', 'data must be Uint8Array');
            return;
        }

        try {
            // HAL Socket.write() may block or buffer internally
            await this.socket.write(data);
            // Assume all bytes written (HAL doesn't return partial writes)
            yield respond.ok({ written: data.length });
        } catch (err) {
            // Catch socket errors (connection reset, peer closed, etc.)
            yield respond.error('EIO', (err as Error).message);
        }
    }

    // =========================================================================
    // LIFECYCLE MANAGEMENT
    // =========================================================================

    /**
     * Close the socket handle.
     *
     * ALGORITHM:
     * 1. Check if already closed (idempotent)
     * 2. Set local _closed flag
     * 3. Close underlying HAL socket
     *
     * WHY idempotent:
     * Caller may call close() multiple times (error handling, cleanup).
     * Double-close should not throw or have side effects.
     *
     * RACE CONDITION:
     * Multiple concurrent close() calls are safe - first one does actual
     * close, subsequent calls no-op. No lock needed.
     */
    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.socket.close();
    }

    // =========================================================================
    // INTERNAL ACCESSORS (for kernel)
    // =========================================================================

    /**
     * Get underlying HAL socket.
     *
     * WHY: Allows kernel-internal operations to access socket directly
     * without going through message dispatch. Used for special operations
     * like socket options or passing to other subsystems.
     *
     * TESTING: Allows tests to inspect socket state directly.
     *
     * @returns Wrapped HAL Socket
     */
    getSocket(): Socket {
        return this.socket;
    }

    /**
     * Get cached socket metadata.
     *
     * WHY: Provides direct access to cached stat without async overhead.
     * Used internally and by tests. Public stat() operation goes through
     * message dispatch.
     *
     * @returns Socket addresses and ports
     */
    stat(): { remoteAddr: string; remotePort: number; localAddr: string; localPort: number } {
        return this._stat;
    }
}
