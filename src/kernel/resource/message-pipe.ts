/**
 * Message Pipe
 *
 * Message-based pipe for inter-process communication.
 * Unlike byte-based PipeBuffer, MessagePipe passes Response objects directly.
 *
 * Terminology:
 * - recv: receive end (read messages from pipe)
 * - send: send end (write messages to pipe)
 * - Messages use recv/send, bytes use read/write
 */

import type { Handle, HandleType } from '../handle/types.js';
import type { Message, Response } from '../../message.js';
import { respond } from '../../message.js';
import { EAGAIN, EPIPE } from '../../hal/errors.js';

/** Pipe end type - recv or send */
export type PipeEnd = 'recv' | 'send';

/** Default high water mark for message count */
const MESSAGE_PIPE_HIGH_WATER = 1000;

/**
 * Shared message queue backing both ends of a pipe.
 * Messages flow: send-end -> queue -> recv-end
 */
class MessageQueue {
    private messages: Response[] = [];
    private waiters: Array<(msg: Response | null) => void> = [];
    private sendClosed = false;
    private recvClosed = false;
    private readonly highWaterMark: number;

    constructor(highWaterMark: number = MESSAGE_PIPE_HIGH_WATER) {
        this.highWaterMark = highWaterMark;
    }

    /**
     * Check if queue is at or above high water mark
     */
    get full(): boolean {
        return this.messages.length >= this.highWaterMark;
    }

    /**
     * Get current message count
     */
    get size(): number {
        return this.messages.length;
    }

    /**
     * Check if both ends are closed
     */
    get fullyClosed(): boolean {
        return this.sendClosed && this.recvClosed;
    }

    /**
     * Send a message into the queue (called from send-end)
     *
     * @throws EPIPE if recv end is closed
     * @throws EAGAIN if queue is full (backpressure)
     */
    send(msg: Response): void {
        if (this.recvClosed) {
            throw new EPIPE('Recv end closed');
        }
        if (this.sendClosed) {
            throw new EPIPE('Send end closed');
        }

        // If there are waiters, give message directly
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

    /**
     * Receive a message from the queue (called from recv-end)
     *
     * Blocks if queue is empty and send end is open.
     * Returns null on EOF (send end closed, queue empty).
     */
    async recv(): Promise<Response | null> {
        // If we have messages, return one
        if (this.messages.length > 0) {
            return this.messages.shift()!;
        }

        // No messages - if send end closed, return EOF
        if (this.sendClosed) {
            return null;
        }

        // Block until message available or EOF
        return new Promise(resolve => {
            this.waiters.push(resolve);
        });
    }

    /**
     * Close send end - signals EOF to receivers
     */
    closeSend(): void {
        if (this.sendClosed) return;
        this.sendClosed = true;

        // Wake all waiters with EOF
        for (const waiter of this.waiters) {
            waiter(null);
        }
        this.waiters = [];
    }

    /**
     * Close recv end - causes EPIPE on sends
     */
    closeRecv(): void {
        if (this.recvClosed) return;
        this.recvClosed = true;

        // Clear queue since nobody will read it
        this.messages = [];

        // Wake waiters with null (shouldn't happen, but be safe)
        for (const waiter of this.waiters) {
            waiter(null);
        }
        this.waiters = [];
    }
}

/**
 * MessagePipe implements Handle directly.
 * Two instances share a MessageQueue - one for each end.
 *
 * Supported ops:
 * - recv: Receive messages from pipe (recv end only)
 * - send: Send message to pipe (send end only)
 */
export class MessagePipe implements Handle {
    readonly type: HandleType = 'pipe';
    readonly id: string;
    readonly description: string;
    readonly end: PipeEnd;

    private _closed = false;
    private readonly queue: MessageQueue;

    constructor(
        id: string,
        end: PipeEnd,
        queue: MessageQueue,
        description: string
    ) {
        this.id = id;
        this.end = end;
        this.queue = queue;
        this.description = description;
    }

    get closed(): boolean {
        return this._closed;
    }

    async *exec(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;

        switch (op) {
            case 'recv':
                if (this.end !== 'recv') {
                    yield respond.error('EBADF', 'Cannot recv from send end of pipe');
                    return;
                }
                yield* this.doRecv();
                break;

            case 'send':
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

    /**
     * Receive all messages until EOF
     */
    private async *doRecv(): AsyncIterable<Response> {
        try {
            while (true) {
                const msg = await this.queue.recv();
                if (msg === null) {
                    yield respond.done();
                    return;
                }
                yield msg; // Pass through the Response directly
            }
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    /**
     * Send a single message
     */
    private async *doSend(msg: Response): AsyncIterable<Response> {
        try {
            this.queue.send(msg);
            yield respond.ok();
        } catch (err) {
            if (err instanceof EPIPE) {
                yield respond.error('EPIPE', err.message);
            } else if (err instanceof EAGAIN) {
                yield respond.error('EAGAIN', err.message);
            } else {
                yield respond.error('EIO', (err as Error).message);
            }
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        if (this.end === 'send') {
            this.queue.closeSend();
        } else {
            this.queue.closeRecv();
        }
    }

    /**
     * Get the shared queue (for kernel internals/testing)
     */
    getQueue(): MessageQueue {
        return this.queue;
    }
}

/**
 * Factory to create a pipe pair (recv-end, send-end)
 *
 * @param pipeId - Unique identifier for this pipe
 * @param highWaterMark - Max messages before backpressure (default 1000)
 * @returns Tuple of [recvEnd, sendEnd] handles
 */
export function createMessagePipe(
    pipeId: string,
    highWaterMark?: number
): [MessagePipe, MessagePipe] {
    const queue = new MessageQueue(highWaterMark);

    const recvEnd = new MessagePipe(
        `${pipeId}:recv`,
        'recv',
        queue,
        `pipe:${pipeId}:recv`
    );

    const sendEnd = new MessagePipe(
        `${pipeId}:send`,
        'send',
        queue,
        `pipe:${pipeId}:send`
    );

    return [recvEnd, sendEnd];
}
