/**
 * MessagePipe - Message-based IPC pipe for inter-process communication
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * MessagePipe provides a message-oriented communication channel between processes,
 * unlike byte-oriented PipeBuffer. It passes Response objects directly rather than
 * serializing to bytes. This design enables structured message passing with
 * backpressure control and EOF signaling.
 *
 * The pipe consists of two ends sharing a MessageQueue:
 * - recv end: receives messages from the queue (read-only)
 * - send end: sends messages to the queue (write-only)
 *
 * Messages flow unidirectionally: send-end -> queue -> recv-end. Each end
 * implements the Handle interface, allowing them to be managed by the kernel's
 * handle table and participate in the standard message dispatch protocol.
 *
 * STATE MACHINE (MessageQueue)
 * ============================
 *
 *   [OPEN] ──────────────> [SEND_CLOSED] ──────> [FULLY_CLOSED]
 *      │                          │                      ^
 *      │ closeSend()              │ closeRecv()          │
 *      │                          └──────────────────────┘
 *      │
 *      └────> [RECV_CLOSED] ─────────────────────────────┘
 *                  │ closeRecv()
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Messages array length never exceeds highWaterMark
 * INV-2: Waiters list is empty when messages array is non-empty
 * INV-3: Once sendClosed is true, no more messages can be added to queue
 * INV-4: Once recvClosed is true, messages array is empty
 * INV-5: Each MessagePipe has exactly one end type (recv or send)
 * INV-6: Both pipes in a pair share the same MessageQueue instance
 * INV-7: Once a pipe is closed, it never reopens
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. The queue
 * uses a promise-based waiter pattern for blocking recv operations when the queue
 * is empty. Multiple receivers can wait simultaneously (though typical usage is
 * one receiver), and they are served in FIFO order.
 *
 * Sends are synchronous - they either succeed immediately, throw EAGAIN for
 * backpressure, or throw EPIPE if the recv end is closed. This prevents unbounded
 * buffering and enables explicit backpressure handling by senders.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check _closed flag before every operation to prevent use-after-close
 * RC-2: Waiters are awakened before clearing the waiter list to prevent lost wakeups
 * RC-3: Closure state checks are performed before queue operations to provide clear errors
 * RC-4: Queue is cleared immediately on recv-end closure to free memory
 *
 * MEMORY MANAGEMENT
 * =================
 * - Messages are queued until received or the recv-end closes
 * - Waiters are cleared on any closure to prevent promise leaks
 * - Queue memory is bounded by highWaterMark (backpressure prevents overflow)
 * - Closing recv-end immediately clears buffered messages (nothing will read them)
 * - Both ends must be closed for queue to be garbage collected
 *
 * @module kernel/resource/message-pipe
 */

// =============================================================================
// IMPORTS
// =============================================================================

import type { Handle, HandleType } from '../handle/types.js';
import type { Message, Response } from '../../message.js';
import { respond } from '../../message.js';
import { EAGAIN, EPIPE } from '../../hal/errors.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default high water mark for message count.
 *
 * WHY: 1000 messages provides reasonable buffering for bursty traffic while
 * preventing unbounded memory growth. This value balances throughput (avoiding
 * frequent backpressure) with memory safety (bounded queue size).
 */
const MESSAGE_PIPE_HIGH_WATER = 1000;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Pipe end type - determines which operations are permitted.
 *
 * - recv: Allows receiving messages (read-only)
 * - send: Allows sending messages (write-only)
 *
 * WHY separate types: Enforces unidirectional data flow and prevents
 * bidirectional confusion. Each end has clear semantics.
 */
export type PipeEnd = 'recv' | 'send';

// =============================================================================
// MESSAGE QUEUE (INTERNAL)
// =============================================================================

/**
 * Shared message queue backing both ends of a pipe.
 *
 * Messages flow: send-end -> queue -> recv-end
 *
 * DESIGN RATIONALE:
 * The queue acts as the single source of truth for pipe state. Both ends
 * reference the same queue instance, ensuring consistent EOF behavior and
 * synchronization. Separating the queue from the handles allows the kernel
 * to close ends independently while maintaining correct semantics.
 */
class MessageQueue {
    // =========================================================================
    // STATE - MESSAGE BUFFER
    // =========================================================================

    /**
     * Buffered messages awaiting receipt.
     *
     * WHY: Messages are queued to decouple sender and receiver speeds.
     * INVARIANT: Length never exceeds highWaterMark (INV-1).
     * INVARIANT: Empty when waiters is non-empty (INV-2).
     */
    private messages: Response[] = [];

    /**
     * Pending receivers waiting for messages.
     *
     * WHY: Allows recv() to block when queue is empty without polling.
     * INVARIANT: Empty when messages is non-empty (INV-2).
     * MEMORY: Cleared on close to prevent promise leaks.
     */
    private waiters: Array<(msg: Response | null) => void> = [];

    // =========================================================================
    // STATE - CLOSURE FLAGS
    // =========================================================================

    /**
     * Whether send end has been closed.
     *
     * WHY: Signals EOF to receivers. Once true, no more messages can be sent.
     * INVARIANT: Once true, never becomes false (INV-3).
     */
    private sendClosed = false;

    /**
     * Whether recv end has been closed.
     *
     * WHY: Causes EPIPE on sends. Indicates nobody will read buffered messages.
     * INVARIANT: Once true, messages array is empty (INV-4).
     */
    private recvClosed = false;

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    /**
     * Maximum message count before backpressure.
     *
     * WHY: Bounds memory usage and prevents fast senders from overwhelming
     * slow receivers. Senders get EAGAIN and must retry or buffer externally.
     */
    private readonly highWaterMark: number;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new message queue.
     *
     * @param highWaterMark - Max messages before EAGAIN (default: 1000)
     */
    constructor(highWaterMark: number = MESSAGE_PIPE_HIGH_WATER) {
        this.highWaterMark = highWaterMark;
    }

    // =========================================================================
    // STATE ACCESSORS (for backpressure and cleanup checks)
    // =========================================================================

    /**
     * Check if queue is at or above high water mark.
     *
     * WHY: Allows callers to check capacity before sending. Not strictly
     * necessary since send() throws EAGAIN, but useful for diagnostics.
     *
     * @returns True if queue is full
     */
    get full(): boolean {
        return this.messages.length >= this.highWaterMark;
    }

    /**
     * Get current message count.
     *
     * TESTING: Allows tests to verify no leaks and check backpressure behavior.
     *
     * @returns Number of buffered messages
     */
    get size(): number {
        return this.messages.length;
    }

    /**
     * Check if both ends are closed.
     *
     * WHY: Allows kernel to determine when queue is eligible for garbage collection.
     *
     * @returns True if both send and recv ends are closed
     */
    get fullyClosed(): boolean {
        return this.sendClosed && this.recvClosed;
    }

    // =========================================================================
    // SEND OPERATIONS
    // =========================================================================

    /**
     * Send a message into the queue (called from send-end).
     *
     * ALGORITHM:
     * 1. Check closure states (recv-end or send-end closed -> EPIPE)
     * 2. If waiters exist, deliver message directly to first waiter
     * 3. If queue is full, throw EAGAIN for backpressure
     * 4. Otherwise, append message to queue
     *
     * WHY deliver directly to waiters:
     * Avoids unnecessary queue growth when a receiver is already waiting.
     * This is an optimization that maintains FIFO ordering (oldest waiter
     * gets the message).
     *
     * WHY throw EAGAIN instead of blocking:
     * Synchronous backpressure allows senders to decide how to handle a full
     * pipe (retry, buffer elsewhere, drop, etc). Async blocking would hide
     * the problem and potentially deadlock if both ends are waiting.
     *
     * @param msg - Response message to send
     * @throws EPIPE - If recv end is closed
     * @throws EPIPE - If send end is closed
     * @throws EAGAIN - If queue is full (backpressure)
     */
    send(msg: Response): void {
        // RACE FIX: Check closure before operation
        if (this.recvClosed) {
            throw new EPIPE('Recv end closed');
        }

        if (this.sendClosed) {
            throw new EPIPE('Send end closed');
        }

        // Fast path: deliver directly to waiting receiver
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!;

            waiter(msg);

            return;
        }

        // Check capacity - apply backpressure if full
        if (this.messages.length >= this.highWaterMark) {
            throw new EAGAIN('Pipe full');
        }

        this.messages.push(msg);
    }

    // =========================================================================
    // RECV OPERATIONS
    // =========================================================================

    /**
     * Receive a message from the queue (called from recv-end).
     *
     * ALGORITHM:
     * 1. If messages available, return oldest message
     * 2. If send end closed (and queue empty), return null for EOF
     * 3. Otherwise, add waiter promise and block until message or EOF
     *
     * WHY return null for EOF:
     * Follows POSIX semantics where read() returns 0 at EOF. Null is
     * unambiguous and can't be confused with a valid message.
     *
     * WHY promises never reject:
     * Simplifies caller error handling. Closure is signaled via null return,
     * not rejection. Errors would only occur for programming bugs, not normal
     * EOF scenarios.
     *
     * RACE CONDITION:
     * Multiple concurrent recv() calls will queue multiple waiters. They are
     * served in FIFO order as messages arrive or EOF occurs. This is safe but
     * unusual - typical usage has one receiver.
     *
     * @returns Next message, or null on EOF
     */
    async recv(): Promise<Response | null> {
        // Fast path: return buffered message
        if (this.messages.length > 0) {
            return this.messages.shift()!;
        }

        // No messages - if send end closed, return EOF
        if (this.sendClosed) {
            return null;
        }

        // Block until message available or EOF
        // WHY no timeout: Caller is responsible for timeout logic if needed
        return new Promise(resolve => {
            this.waiters.push(resolve);
        });
    }

    // =========================================================================
    // CLOSURE OPERATIONS
    // =========================================================================

    /**
     * Close send end - signals EOF to receivers.
     *
     * ALGORITHM:
     * 1. Mark sendClosed = true
     * 2. Wake all waiting receivers with null (EOF)
     * 3. Clear waiter list
     *
     * WHY wake waiters with null:
     * Any pending recv() calls will unblock and see EOF. This prevents
     * receivers from hanging indefinitely when the sender disappears.
     *
     * MEMORY: Clearing waiters prevents promise leak if caller abandons recv().
     */
    closeSend(): void {
        if (this.sendClosed) {
            return;
        }

        this.sendClosed = true;

        // RC-2: Wake all waiters before clearing list
        for (const waiter of this.waiters) {
            waiter(null);
        }

        this.waiters = [];
    }

    /**
     * Close recv end - causes EPIPE on sends.
     *
     * ALGORITHM:
     * 1. Mark recvClosed = true
     * 2. Clear message queue (nobody will read it)
     * 3. Wake all waiters with null (shouldn't happen, but defensive)
     * 4. Clear waiter list
     *
     * WHY clear message queue:
     * If recv end is closed, buffered messages will never be read. Clearing
     * immediately frees memory instead of waiting for send-end closure.
     *
     * WHY wake waiters:
     * Defensive programming. Waiters shouldn't exist (recv-end is closed),
     * but if they do, we wake them to prevent hangs.
     *
     * MEMORY: RC-4 mitigation - immediate cleanup prevents memory leaks.
     */
    closeRecv(): void {
        if (this.recvClosed) {
            return;
        }

        this.recvClosed = true;

        // Free memory immediately (INV-4)
        this.messages = [];

        // RC-2: Wake waiters before clearing (defensive)
        for (const waiter of this.waiters) {
            waiter(null);
        }

        this.waiters = [];
    }
}

// =============================================================================
// MESSAGE PIPE HANDLE
// =============================================================================

/**
 * MessagePipe implements Handle for message-based IPC.
 *
 * Two instances share a MessageQueue - one for each end. Each end is
 * restricted to either recv or send operations based on its PipeEnd type.
 *
 * SUPPORTED OPERATIONS:
 * - recv: Receive messages from pipe (recv end only, async generator)
 * - send: Send message to pipe (send end only, single response)
 *
 * DESIGN RATIONALE:
 * Implementing Handle allows pipes to be stored in the kernel's handle table
 * and participate in standard message dispatch. The exec() method translates
 * handle messages into queue operations.
 */
export class MessagePipe implements Handle {
    // =========================================================================
    // HANDLE IDENTITY
    // =========================================================================

    /**
     * Handle type identifier.
     *
     * WHY: Allows kernel to distinguish pipe handles from file handles, etc.
     * INVARIANT: Always 'pipe' for this handle type.
     */
    readonly type: HandleType = 'pipe';

    /**
     * Unique handle identifier.
     *
     * WHY: Enables handle tracking and lookup in kernel handle table.
     * FORMAT: "${pipeId}:${end}" (e.g., "pipe123:recv")
     */
    readonly id: string;

    /**
     * Human-readable description.
     *
     * WHY: Aids debugging by showing pipe identity in handle listings.
     * FORMAT: "pipe:${pipeId}:${end}"
     */
    readonly description: string;

    /**
     * Which end of the pipe this handle represents.
     *
     * WHY: Determines which operations are permitted (recv or send).
     * INVARIANT: INV-5 - never changes after construction.
     */
    readonly end: PipeEnd;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether this handle has been closed.
     *
     * WHY: Prevents operations on closed handles.
     * INVARIANT: INV-7 - once true, never becomes false.
     */
    private _closed = false;

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Shared message queue.
     *
     * WHY: Both pipe ends reference the same queue for synchronization.
     * INVARIANT: INV-6 - both ends share the exact same instance.
     */
    private readonly queue: MessageQueue;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new MessagePipe handle.
     *
     * NOTE: Use createMessagePipe() factory instead of calling directly.
     * The factory ensures both ends share the same queue.
     *
     * @param id - Unique handle ID
     * @param end - Which end of the pipe (recv or send)
     * @param queue - Shared message queue
     * @param description - Human-readable description
     */
    constructor(
        id: string,
        end: PipeEnd,
        queue: MessageQueue,
        description: string,
    ) {
        this.id = id;
        this.end = end;
        this.queue = queue;
        this.description = description;
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    /**
     * Check if handle is closed.
     *
     * WHY: Exposes closure state for kernel handle management.
     *
     * @returns True if closed
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // HANDLE OPERATIONS (exec dispatch)
    // =========================================================================

    /**
     * Execute a handle operation.
     *
     * ALGORITHM:
     * 1. Check handle closure state
     * 2. Dispatch based on op type (recv or send)
     * 3. Validate operation is allowed for this end
     * 4. Execute operation and yield responses
     *
     * WHY async generator:
     * recv operations produce multiple responses (one per message plus done).
     * Generators provide natural streaming semantics.
     *
     * RACE CONDITION:
     * RC-1 - closure check before every operation prevents use-after-close.
     *
     * @param msg - Handle operation message
     * @yields Response messages
     */
    async *exec(msg: Message): AsyncIterable<Response> {
        // RC-1: Check closure before operation
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');

            return;
        }

        const op = msg.op;

        switch (op) {
            case 'recv':
                // Validate operation is allowed for this end
                if (this.end !== 'recv') {
                    yield respond.error('EBADF', 'Cannot recv from send end of pipe');

                    return;
                }

                yield* this.doRecv();
                break;

            case 'send':
                // Validate operation is allowed for this end
                if (this.end !== 'send') {
                    yield respond.error('EBADF', 'Cannot send to recv end of pipe');

                    return;
                }

                yield* this.doSend(msg.data as Response);
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    // =========================================================================
    // OPERATION IMPLEMENTATIONS
    // =========================================================================

    /**
     * Receive all messages until EOF.
     *
     * ALGORITHM:
     * 1. Loop: call queue.recv()
     * 2. If null returned, yield done() and exit
     * 3. Otherwise, yield the message and continue
     *
     * WHY loop until null:
     * Provides streaming semantics. Caller gets messages as they arrive
     * until the send end closes and the queue drains.
     *
     * ERROR HANDLING:
     * Errors from queue.recv() are caught and translated to EIO responses.
     * This shouldn't happen in normal operation (queue methods don't throw
     * during recv), but defensive catch prevents unhandled rejections.
     *
     * @yields Received messages, then done response
     */
    private async *doRecv(): AsyncIterable<Response> {
        try {
            while (true) {
                const msg = await this.queue.recv();

                if (msg === null) {
                    // EOF - send end closed and queue drained
                    yield respond.done();

                    return;
                }

                // Pass through the Response directly
                yield msg;
            }
        }
        catch (err) {
            // Defensive - queue.recv() shouldn't throw
            yield respond.error('EIO', (err as Error).message);
        }
    }

    /**
     * Send a single message.
     *
     * ALGORITHM:
     * 1. Call queue.send(msg)
     * 2. If succeeds, yield ok()
     * 3. If EPIPE, yield EPIPE error (receiver closed)
     * 4. If EAGAIN, yield EAGAIN error (backpressure)
     * 5. If other error, yield EIO
     *
     * WHY translate exceptions to responses:
     * Handle interface requires returning responses, not throwing. This
     * follows the message-based error handling pattern used throughout
     * the kernel.
     *
     * @param msg - Message to send
     * @yields Single response (ok or error)
     */
    private async *doSend(msg: Response): AsyncIterable<Response> {
        try {
            this.queue.send(msg);
            yield respond.ok();
        }
        catch (err) {
            if (err instanceof EPIPE) {
                yield respond.error('EPIPE', err.message);
            }
            else if (err instanceof EAGAIN) {
                yield respond.error('EAGAIN', err.message);
            }
            else {
                // Defensive - other errors shouldn't occur
                yield respond.error('EIO', (err as Error).message);
            }
        }
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close this pipe end.
     *
     * ALGORITHM:
     * 1. If already closed, return (idempotent)
     * 2. Mark _closed = true
     * 3. Close appropriate end of queue (send or recv)
     *
     * WHY idempotent:
     * Allows safe double-close without errors. Kernel may close handles
     * multiple times during cleanup.
     *
     * SIDE EFFECTS:
     * - Closing send-end wakes waiting receivers with EOF
     * - Closing recv-end causes EPIPE on future sends
     * - Both ends must close before queue is garbage collected
     */
    async close(): Promise<void> {
        if (this._closed) {
            return;
        }

        this._closed = true;

        if (this.end === 'send') {
            this.queue.closeSend();
        }
        else {
            this.queue.closeRecv();
        }
    }

    // =========================================================================
    // TESTING SUPPORT
    // =========================================================================

    /**
     * Get the shared queue.
     *
     * TESTING: Allows tests to inspect queue state (size, closure, etc).
     * KERNEL USE: Allows kernel to check if both ends are closed for cleanup.
     *
     * @returns The underlying MessageQueue
     */
    getQueue(): MessageQueue {
        return this.queue;
    }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Factory to create a pipe pair (recv-end, send-end).
 *
 * ALGORITHM:
 * 1. Create shared MessageQueue
 * 2. Create recv-end MessagePipe with queue
 * 3. Create send-end MessagePipe with same queue
 * 4. Return tuple [recv, send]
 *
 * WHY factory instead of constructor:
 * Ensures both ends share the same queue (INV-6). Prevents accidental
 * misuse where separate queues would be created.
 *
 * USAGE PATTERN:
 * ```
 * const [recv, send] = createMessagePipe('pipe123');
 * // Give recv to one process, send to another
 * ```
 *
 * @param pipeId - Unique identifier for this pipe
 * @param highWaterMark - Max messages before backpressure (default: 1000)
 * @returns Tuple of [recvEnd, sendEnd] handles
 */
export function createMessagePipe(
    pipeId: string,
    highWaterMark?: number,
): [MessagePipe, MessagePipe] {
    const queue = new MessageQueue(highWaterMark);

    const recvEnd = new MessagePipe(
        `${pipeId}:recv`,
        'recv',
        queue,
        `pipe:${pipeId}:recv`,
    );

    const sendEnd = new MessagePipe(
        `${pipeId}:send`,
        'send',
        queue,
        `pipe:${pipeId}:send`,
    );

    return [recvEnd, sendEnd];
}
