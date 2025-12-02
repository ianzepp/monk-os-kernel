/**
 * Pipe Handle Adapter
 *
 * Wraps shared PipeBuffer in the unified handle interface.
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import { PipeBuffer } from '@src/kernel/resource.js';
import { DEFAULT_CHUNK_SIZE, MAX_STREAM_BYTES } from '@src/kernel/types.js';
import type { Handle, HandleType } from './types.js';

/**
 * Pipe end type
 */
export type PipeEnd = 'read' | 'write';

/**
 * Pipe handle wrapping shared PipeBuffer.
 *
 * Supported ops:
 * - recv: Read from pipe (read end only)
 * - send: Write to pipe (write end only)
 */
export class PipeHandleAdapter implements Handle {
    readonly type: HandleType = 'pipe';
    private _closed = false;

    constructor(
        readonly id: string,
        private buffer: PipeBuffer,
        readonly end: PipeEnd,
        readonly description: string
    ) {}

    get closed(): boolean {
        return this._closed;
    }

    async *exec(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'recv':
                if (this.end !== 'read') {
                    yield respond.error('EBADF', 'Cannot read from write end of pipe');
                    return;
                }
                yield* this.recv(data?.chunkSize as number | undefined);
                break;

            case 'send':
                if (this.end !== 'write') {
                    yield respond.error('EBADF', 'Cannot write to read end of pipe');
                    return;
                }
                yield* this.send(data?.data as Uint8Array);
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    private async *recv(chunkSize?: number): AsyncIterable<Response> {
        const size = chunkSize ?? DEFAULT_CHUNK_SIZE;
        let totalYielded = 0;

        try {
            while (true) {
                const chunk = await this.buffer.read(size);

                // EOF
                if (chunk.length === 0) {
                    break;
                }

                totalYielded += chunk.length;
                if (totalYielded > MAX_STREAM_BYTES) {
                    yield respond.error('EFBIG', `Read stream exceeded ${MAX_STREAM_BYTES} bytes`);
                    return;
                }

                yield respond.chunk(chunk);
            }

            yield respond.done();
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    private async *send(data: Uint8Array): AsyncIterable<Response> {
        if (!(data instanceof Uint8Array)) {
            yield respond.error('EINVAL', 'data must be Uint8Array');
            return;
        }

        try {
            const written = this.buffer.write(data);
            yield respond.ok({ written });
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        if (this.end === 'read') {
            this.buffer.closeReadEnd();
        } else {
            this.buffer.closeWriteEnd();
        }
    }

    /**
     * Get the shared buffer (for kernel internals)
     */
    getBuffer(): PipeBuffer {
        return this.buffer;
    }
}
