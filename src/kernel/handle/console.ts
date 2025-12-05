/**
 * ConsoleHandleAdapter - Message-based console I/O bridge
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * ConsoleHandleAdapter bridges the message-based process I/O model with the
 * byte-based console device interface. This adapter sits at the boundary where
 * Response messages from processes become bytes for display on the console,
 * and where keyboard input bytes become Response messages for processes.
 *
 * The console has three modes: stdin (read-only), stdout (write-only), and
 * stderr (write-only). Each mode is represented by a separate handle instance
 * that enforces directional I/O. This design mirrors UNIX file descriptor 0/1/2
 * where stdin cannot be written to and stdout/stderr cannot be read from.
 *
 * Message flow for output (stdout/stderr):
 *   1. Process sends: respond.item({ text: 'hello\n' })
 *   2. ConsoleHandleAdapter extracts text and encodes to bytes
 *   3. Bytes written to ConsoleDevice.write() or .error()
 *   4. ConsoleDevice displays bytes to user
 *
 * Message flow for input (stdin):
 *   1. ConsoleDevice.readline() blocks waiting for input
 *   2. User types line and presses enter
 *   3. ConsoleHandleAdapter wraps line in respond.item({ text: 'line\n' })
 *   4. Process receives message via recv operation
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: stdin handles only support recv operations, never send
 * INV-2: stdout/stderr handles only support send operations, never recv
 * INV-3: mode is immutable after construction
 * INV-4: Once closed, no further I/O operations succeed (all return EBADF)
 * INV-5: Text encoding is always UTF-8
 * INV-6: stdin readline() always appends '\n' to yield messages
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * processes can have concurrent handles to stdout/stderr. The ConsoleDevice is
 * responsible for serializing writes - this adapter does not provide any
 * buffering or synchronization.
 *
 * For stdin, readline() is async and blocks until user input arrives. Only one
 * process should typically read from stdin (the foreground process), but this
 * is enforced at the shell/kernel level, not by the adapter.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check _closed before every I/O operation to prevent use-after-close
 * RC-2: No shared mutable state between handle instances (each has own encoder)
 * RC-3: ConsoleDevice is responsible for write ordering (not this adapter)
 *
 * MEMORY MANAGEMENT
 * =================
 * - TextEncoder is created once and reused for all text-to-bytes conversions
 * - No buffering is performed - bytes are written immediately to ConsoleDevice
 * - Callers should use `await handle.close()` for cleanup
 *
 * @module kernel/handle/console
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { ConsoleDevice } from '@src/hal/index.js';
import type { Handle, HandleType } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Console mode discriminator.
 *
 * WHY: Enforces directional I/O constraints at type level.
 *
 * - stdin: Read-only, yields lines from keyboard
 * - stdout: Write-only, normal output
 * - stderr: Write-only, error output
 */
type ConsoleMode = 'stdin' | 'stdout' | 'stderr';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * ConsoleHandleAdapter - Message-based console I/O adapter.
 *
 * Implements the Handle interface for console devices, translating between
 * message-based process I/O and byte-based console I/O.
 */
export class ConsoleHandleAdapter implements Handle {
    // =========================================================================
    // HANDLE IDENTITY
    // =========================================================================

    /**
     * Handle type discriminator.
     *
     * WHY: Enables kernel to dispatch operations based on handle type.
     * INVARIANT: Always 'file' for console handles (console is a special file).
     */
    readonly type: HandleType = 'file';

    /**
     * Unique handle identifier.
     *
     * WHY: Allows kernel to track and revoke handles.
     * INVARIANT: Immutable after construction.
     */
    readonly id: string;

    /**
     * Console mode (stdin/stdout/stderr).
     *
     * WHY: Determines read vs write permissions and target device stream.
     * INVARIANT: Immutable after construction.
     */
    private readonly mode: ConsoleMode;

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Console device for byte-level I/O.
     *
     * WHY: Provides actual readline/write/error operations.
     * INVARIANT: Non-null and valid throughout handle lifetime.
     */
    private readonly console: ConsoleDevice;

    /**
     * Text encoder for converting strings to UTF-8 bytes.
     *
     * WHY: Reused for all text encoding to avoid allocating new encoders.
     * TextEncoder is stateless and safe to reuse.
     */
    private readonly encoder = new TextEncoder();

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether handle has been closed.
     *
     * WHY: Prevents I/O operations on closed handles.
     * INVARIANT: Once true, never becomes false again.
     */
    private _closed = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new ConsoleHandleAdapter.
     *
     * @param id - Unique handle identifier
     * @param console - Console device for I/O
     * @param mode - Console mode (stdin/stdout/stderr)
     */
    constructor(id: string, console: ConsoleDevice, mode: ConsoleMode) {
        this.id = id;
        this.console = console;
        this.mode = mode;
    }

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    /**
     * Get human-readable description.
     *
     * WHY: Useful for debugging and error messages.
     *
     * @returns Description string in format "/dev/console (mode)"
     */
    get description(): string {
        return `/dev/console (${this.mode})`;
    }

    /**
     * Whether handle is closed.
     *
     * WHY: Exposes closure state for external checks.
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // MESSAGE DISPATCH
    // =========================================================================

    /**
     * Execute a message operation on this handle.
     *
     * ALGORITHM:
     * 1. Check if handle is closed
     * 2. Dispatch based on msg.op
     * 3. Yield response messages
     *
     * SUPPORTED OPERATIONS:
     * - recv: Read from stdin (stdin mode only)
     * - send: Write to stdout/stderr (stdout/stderr modes only)
     *
     * @param msg - Message containing operation and data
     * @returns Async iterable of responses
     */
    async *exec(msg: Message): AsyncIterable<Response> {
        // RACE FIX: Check closure state before any operation
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');

            return;
        }

        const op = msg.op;

        switch (op) {
            case 'recv':
                yield* this.recv();
                break;

            case 'send':
                yield* this.send(msg.data as Response);
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    // =========================================================================
    // READ OPERATIONS (STDIN)
    // =========================================================================

    /**
     * Read from console stdin, yielding item messages.
     *
     * ALGORITHM:
     * 1. Verify handle is stdin mode
     * 2. Loop calling console.readline()
     * 3. Wrap each line in respond.item({ text: 'line\n' })
     * 4. Yield done() on EOF (readline returns null)
     *
     * WHY newline is always appended:
     * readline() returns the line without trailing newline, but consumers
     * expect line-oriented input to include the delimiter. This matches
     * UNIX read() behavior on terminal devices.
     *
     * RACE CONDITION:
     * readline() is async and may block indefinitely waiting for input.
     * If handle is closed while readline() is pending, the close() operation
     * completes immediately but readline() may still yield a value. The
     * subsequent iteration will see _closed=true and terminate.
     *
     * @returns Async iterable of item responses
     */
    private async *recv(): AsyncIterable<Response> {
        if (this.mode !== 'stdin') {
            yield respond.error('EBADF', 'Cannot read from stdout/stderr');

            return;
        }

        // Read lines until EOF
        while (true) {
            // RACE POINT: Handle may be closed while waiting for readline()
            const line = await this.console.readline();

            // RACE FIX: Check closure state after async readline()
            if (this._closed) {
                return;
            }

            if (line === null) {
                // EOF reached
                break;
            }

            // Append newline to match line-oriented terminal behavior
            yield respond.item({ text: line + '\n' });
        }

        yield respond.done();
    }

    // =========================================================================
    // WRITE OPERATIONS (STDOUT/STDERR)
    // =========================================================================

    /**
     * Write to console stdout/stderr from Response messages.
     *
     * ALGORITHM:
     * 1. Verify handle is stdout/stderr mode
     * 2. Select writer function (console.write or console.error)
     * 3. Dispatch based on msg.op:
     *    - item: Extract text field and encode to bytes
     *    - data: Write bytes directly
     *    - error: Format error message and encode
     *    - done/ok: No output (silent)
     * 4. Yield ok() response
     *
     * WHY separate write() and error() functions:
     * Some console implementations (e.g., browser console) differentiate
     * between normal output and error output with different styling or
     * logging levels.
     *
     * @param msg - Response message to write
     * @returns Async iterable of responses
     */
    private async *send(msg: Response): AsyncIterable<Response> {
        if (this.mode === 'stdin') {
            yield respond.error('EBADF', 'Cannot write to stdin');

            return;
        }

        // Select writer function based on mode
        // WHY: stderr uses console.error() for proper error stream routing
        const writer = this.mode === 'stderr'
            ? (data: Uint8Array) => this.console.error(data)
            : (data: Uint8Array) => this.console.write(data);

        // Validate message
        if (!msg || typeof msg !== 'object') {
            yield respond.error('EINVAL', 'Invalid message');

            return;
        }

        switch (msg.op) {
            case 'item': {
                // Text item - extract text field and encode to UTF-8
                const data = msg.data as { text?: string } | undefined;
                const text = data?.text ?? '';

                writer(this.encoder.encode(text));
                break;
            }

            case 'data': {
                // Binary data - write bytes directly
                // WHY: Supports raw binary output (e.g., cat of binary file)
                if (msg.bytes instanceof Uint8Array) {
                    writer(msg.bytes);
                }

                break;
            }

            case 'error': {
                // Error message - format and write to console
                // WHY: Provides consistent error formatting across processes
                const data = msg.data as { code?: string; message?: string } | undefined;
                const text = `Error: ${data?.code ?? 'UNKNOWN'}: ${data?.message ?? 'Unknown error'}\n`;

                writer(this.encoder.encode(text));
                break;
            }

            // done, ok, etc. - no output
            // WHY: Control flow messages don't produce visible output
        }

        yield respond.ok();
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close the handle.
     *
     * Sets _closed flag to prevent further I/O. Does not close the underlying
     * console device (which may be shared by multiple handles).
     *
     * WHY console device is not closed:
     * Multiple processes may have handles to stdout/stderr. Closing the shared
     * console device would break all other handles. The console device has its
     * own lifecycle managed by the kernel.
     *
     * Safe to call multiple times - subsequent calls are no-ops.
     */
    async close(): Promise<void> {
        this._closed = true;
    }
}
