/**
 * File Handle Adapter - Wraps VFS FileHandle in the unified handle interface
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * FileHandleAdapter bridges the VFS file abstraction with the kernel's unified
 * handle interface. It translates message-based operations (recv/send/seek/stat)
 * into VFS FileHandle method calls, enabling processes to interact with files
 * through the same interface used for sockets, pipes, and other I/O resources.
 *
 * The adapter wraps a VFS FileHandle and exposes it through the kernel's Handle
 * interface, which uses async generators to stream responses. This design allows
 * file I/O to be multiplexed with other operations and supports streaming large
 * files without buffering everything in memory.
 *
 * File handles support four operations:
 * - recv: Stream file content in chunks until EOF
 * - send: Write data to file (supports both binary and text)
 * - seek: Change file position for random access
 * - stat: Get file metadata (path, size, timestamps)
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
 * INV-2: closed getter reflects both local _closed flag AND underlying handle state
 * INV-3: recv() never yields more than MAX_STREAM_BYTES total
 * INV-4: send() accepts multiple data formats transparently (syscall vs redirect)
 * INV-5: Handle ID is immutable and unique for entire handle lifetime
 * INV-6: Type is always 'file' (never changes)
 *
 * CONCURRENCY MODEL
 * =================
 * Each FileHandleAdapter instance wraps a single VFS FileHandle. The VFS handle
 * maintains its own state (position, dirty flag, content buffer). Multiple
 * adapters can wrap different handles to the same file - each has independent
 * position and buffer state (snapshot isolation, last-write-wins on close).
 *
 * Operations are async and can interleave at await points. The adapter checks
 * the closed state at the start of each operation to prevent use-after-close.
 * However, the underlying VFS handle may be closed by another reference - the
 * closed getter checks both states.
 *
 * The recv() operation streams chunks via async generator. Concurrent recv()
 * calls on the same handle would interleave chunks (undefined behavior). Callers
 * must ensure exclusive access to recv() operations.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check _closed at operation entry - prevents ops after explicit close()
 * RC-2: closed getter checks both flags - detects external handle closure
 * RC-3: recv() enforces MAX_STREAM_BYTES limit - prevents infinite read loops
 * RC-4: send() validates data format early - fails fast on invalid input
 * RC-5: Error catching in all operations - converts exceptions to error responses
 *
 * MEMORY MANAGEMENT
 * =================
 * - Adapter holds reference to VFS FileHandle until close()
 * - No internal buffering (recv reads directly from VFS handle)
 * - TextEncoder is reused across send() calls to avoid allocation
 * - Handle cleanup responsibility lies with caller (should use await using)
 * - Close is idempotent - safe to call multiple times
 *
 * @module kernel/handle/file
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { FileHandle as VfsFileHandle, SeekWhence } from '@src/vfs/index.js';
import { DEFAULT_CHUNK_SIZE, MAX_STREAM_BYTES } from '@src/kernel/types.js';
import type { Handle, HandleType } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Supported file handle operations.
 *
 * WHY: Type-safe operation dispatch ensures only valid ops are processed.
 *
 * Operations:
 * - recv: Stream file content in chunks (read)
 * - send: Write data to file (write)
 * - seek: Change file position (lseek)
 * - stat: Get file metadata (fstat)
 */
type FileOp = 'recv' | 'send' | 'seek' | 'stat';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * FileHandleAdapter - Wraps VFS FileHandle in unified handle interface.
 *
 * Bridges message-based kernel operations with VFS file I/O methods.
 * Supports streaming reads, writes with format conversion, seeking, and stat.
 */
export class FileHandleAdapter implements Handle {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Handle type identifier.
     *
     * WHY: Enables handle type discrimination at runtime.
     * INVARIANT: Always 'file' (never changes).
     */
    readonly type: HandleType = 'file';

    /**
     * Unique handle identifier.
     *
     * WHY: Allows kernel to track and revoke handles by ID.
     * INVARIANT: Immutable and unique for entire handle lifetime.
     */
    readonly id: string;

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

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Underlying VFS file handle.
     *
     * WHY: Provides actual file I/O operations (read/write/seek).
     * The handle may be shared or closed externally - check handle.closed.
     */
    private handle: VfsFileHandle;

    /**
     * Text encoder for send() operation.
     *
     * WHY: Reused across calls to avoid repeated allocation.
     * Converts text items to bytes for writing to file.
     */
    private encoder = new TextEncoder();

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new FileHandleAdapter.
     *
     * @param id - Unique handle identifier
     * @param handle - VFS FileHandle to wrap
     */
    constructor(id: string, handle: VfsFileHandle) {
        this.id = id;
        this.handle = handle;
    }

    // =========================================================================
    // ACCESSORS
    // =========================================================================

    /**
     * Human-readable handle description.
     *
     * WHY: Used in logging and debugging to identify which file is open.
     *
     * @returns File path from underlying VFS handle
     */
    get description(): string {
        return this.handle.path;
    }

    /**
     * Check if handle is closed.
     *
     * WHY: Checks both local _closed flag AND underlying handle state.
     * The VFS handle may be closed externally (e.g., by another adapter).
     *
     * RACE CONDITION: handle.closed may change between check and use.
     * Operations must still validate state at entry.
     *
     * @returns True if either local or underlying handle is closed
     */
    get closed(): boolean {
        return this._closed || this.handle.closed;
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
     * Allows streaming multi-part responses (e.g., file chunks) without
     * buffering everything in memory. Caller can process responses as
     * they arrive.
     *
     * RACE CONDITION:
     * Closed check at entry, but handle may close during operation.
     * Each operation method must validate state before I/O.
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

        const op = msg.op as FileOp;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'recv':
                yield* this.recv(data?.chunkSize as number | undefined);
                break;

            case 'send':
                yield* this.send(msg.data);
                break;

            case 'seek':
                yield* this.seek(data?.offset as number, data?.whence as SeekWhence);
                break;

            case 'stat':
                yield* this.stat();
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    /**
     * Stream file content in chunks until EOF.
     *
     * ALGORITHM:
     * 1. Read chunks from VFS handle in loop
     * 2. Yield each chunk as data response
     * 3. Track total bytes to enforce limit
     * 4. Stop on EOF (zero-length read)
     * 5. Stop on short read (less than chunk size)
     * 6. Yield done response on success
     *
     * WHY enforce MAX_STREAM_BYTES:
     * Prevents infinite reads from corrupted files or devices.
     * Protects against memory exhaustion attacks.
     *
     * WHY stop on short read:
     * VFS read() returns less than requested when EOF is near.
     * Continuing to read would just get zero bytes anyway.
     *
     * @param chunkSize - Bytes per chunk (default: DEFAULT_CHUNK_SIZE)
     * @returns Async generator yielding data chunks and done/error
     */
    private async *recv(chunkSize?: number): AsyncIterable<Response> {
        const size = chunkSize ?? DEFAULT_CHUNK_SIZE;
        let totalYielded = 0;

        try {
            while (true) {
                // RACE FIX: VFS handle may close during read
                // The read() call will throw EBADF if so
                const chunk = await this.handle.read(size);

                // EOF - zero-length read
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

                // Short read indicates EOF approaching
                if (chunk.length < size) {
                    break;
                }
            }

            yield respond.done();
        } catch (err) {
            // Catch VFS errors (EBADF, EACCES, etc.) and convert to EIO
            yield respond.error('EIO', (err as Error).message);
        }
    }

    // =========================================================================
    // WRITE OPERATIONS
    // =========================================================================

    /**
     * Write data to file.
     *
     * ALGORITHM:
     * 1. Detect data format (write syscall vs redirected stdout)
     * 2. Extract bytes (may need to encode text)
     * 3. Write to VFS handle
     * 4. Return bytes written
     *
     * WHY support multiple formats:
     * - write() syscall sends: { data: Uint8Array }
     * - Redirected stdout sends: Response items (text or binary)
     * This enables using files as stdout/stderr destinations.
     *
     * WHY encode text items:
     * Redirected stdout from text-based commands (echo, cat) sends
     * Response items with text field. Must convert to bytes for storage.
     *
     * @param data - Data to write (multiple formats supported)
     * @returns Response with bytes written or error
     */
    private async *send(data: unknown): AsyncIterable<Response> {
        let bytes: Uint8Array;

        // Detect and normalize data format
        if (data && typeof data === 'object') {
            if ('data' in data && (data as { data: unknown }).data instanceof Uint8Array) {
                // From write() syscall: { data: Uint8Array }
                bytes = (data as { data: Uint8Array }).data;
            } else if ('op' in data) {
                // From send() syscall: Response object (for redirected stdout)
                const response = data as Response;
                if (response.op === 'item') {
                    // Text item - extract and encode
                    const itemData = response.data as { text?: string } | undefined;
                    const text = itemData?.text ?? '';
                    bytes = this.encoder.encode(text);
                } else if (response.op === 'data') {
                    // Binary data - use directly
                    bytes = response.bytes ?? new Uint8Array(0);
                } else {
                    // done, ok, error - nothing to write
                    yield respond.ok({ written: 0 });
                    return;
                }
            } else {
                yield respond.error('EINVAL', 'Invalid data format for send');
                return;
            }
        } else {
            yield respond.error('EINVAL', 'data must be object');
            return;
        }

        try {
            // RACE FIX: VFS handle may close during write
            // The write() call will throw EBADF if so
            const written = await this.handle.write(bytes);
            yield respond.ok({ written });
        } catch (err) {
            // Catch VFS errors (EBADF, EACCES, ENOSPC, etc.) and convert to EIO
            yield respond.error('EIO', (err as Error).message);
        }
    }

    // =========================================================================
    // SEEK OPERATIONS
    // =========================================================================

    /**
     * Seek to a position in the file.
     *
     * WHY validate offset type:
     * Message data is untyped - must validate before passing to VFS.
     * Invalid types would cause VFS to throw unclear errors.
     *
     * @param offset - Byte offset from whence
     * @param whence - Reference point: 'start', 'current', or 'end' (default: 'start')
     * @returns Response with new position or error
     */
    private async *seek(offset: number, whence?: SeekWhence): AsyncIterable<Response> {
        if (typeof offset !== 'number') {
            yield respond.error('EINVAL', 'offset must be a number');
            return;
        }

        try {
            // RACE FIX: VFS handle may close during seek
            // The seek() call will throw EBADF if so
            const pos = await this.handle.seek(offset, whence ?? 'start');
            yield respond.ok(pos);
        } catch (err) {
            // Catch VFS errors (EBADF, EINVAL) and convert to EIO
            yield respond.error('EIO', (err as Error).message);
        }
    }

    // =========================================================================
    // METADATA OPERATIONS
    // =========================================================================

    /**
     * Get file metadata.
     *
     * WHY minimal stat info:
     * Currently only returns path. Full stat info (size, timestamps) would
     * require VFS handle to expose entity metadata. This is sufficient for
     * basic handle identification.
     *
     * @returns Response with file metadata or error
     */
    private async *stat(): AsyncIterable<Response> {
        try {
            // VFS FileHandle has entity info
            yield respond.ok({
                path: this.handle.path,
                // Additional stat info would come from VFS
            });
        } catch (err) {
            // Catch any unexpected errors
            yield respond.error('EIO', (err as Error).message);
        }
    }

    // =========================================================================
    // LIFECYCLE MANAGEMENT
    // =========================================================================

    /**
     * Close the file handle.
     *
     * ALGORITHM:
     * 1. Check if already closed (idempotent)
     * 2. Set local _closed flag
     * 3. Close underlying VFS handle (flushes writes)
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
        await this.handle.close();
    }

    // =========================================================================
    // INTERNAL ACCESSORS (for kernel)
    // =========================================================================

    /**
     * Get underlying VFS handle.
     *
     * WHY: Allows kernel-internal operations to access VFS handle directly
     * without going through message dispatch. Used for special operations
     * like dup() or passing handles to other subsystems.
     *
     * TESTING: Allows tests to inspect handle state directly.
     *
     * @returns Wrapped VFS FileHandle
     */
    getHandle(): VfsFileHandle {
        return this.handle;
    }
}
