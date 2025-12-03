/**
 * Console Handle Adapter
 *
 * Bridges message-based process I/O with byte-based console device.
 * This is the boundary where Response messages become bytes for display
 * and bytes from keyboard become Response messages.
 *
 * For stdout/stderr:
 *   Process sends: respond.item({ text: 'hello\n' })
 *   Console receives: bytes encoded from text
 *
 * For stdin:
 *   Console provides: bytes from keyboard
 *   Process receives: respond.item({ text: 'line\n' })
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { ConsoleDevice } from '@src/hal/index.js';
import type { Handle, HandleType } from './types.js';

type ConsoleMode = 'stdin' | 'stdout' | 'stderr';

/**
 * Console handle for message-based I/O.
 *
 * Supported ops:
 * - recv: Read lines from console, yield as item messages (stdin only)
 * - send: Accept item/data messages, write as bytes (stdout/stderr only)
 */
export class ConsoleHandleAdapter implements Handle {
    readonly type: HandleType = 'file';
    private _closed = false;
    private encoder = new TextEncoder();

    constructor(
        readonly id: string,
        private console: ConsoleDevice,
        private mode: ConsoleMode
    ) {}

    get description(): string {
        return `/dev/console (${this.mode})`;
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
                yield* this.recv();
                break;

            case 'send':
                yield* this.send(msg.data as Response);
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    /**
     * Read from console stdin, yielding item messages.
     * Each line becomes a separate item with trailing newline.
     */
    private async *recv(): AsyncIterable<Response> {
        if (this.mode !== 'stdin') {
            yield respond.error('EBADF', 'Cannot read from stdout/stderr');
            return;
        }

        // Read lines until EOF
        while (true) {
            const line = await this.console.readline();
            if (line === null) {
                // EOF
                break;
            }
            yield respond.item({ text: line + '\n' });
        }

        yield respond.done();
    }

    /**
     * Write to console stdout/stderr from Response messages.
     * Extracts text from items, bytes from data responses.
     */
    private async *send(msg: Response): AsyncIterable<Response> {
        if (this.mode === 'stdin') {
            yield respond.error('EBADF', 'Cannot write to stdin');
            return;
        }

        const writer = this.mode === 'stderr'
            ? (data: Uint8Array) => this.console.error(data)
            : (data: Uint8Array) => this.console.write(data);

        if (!msg || typeof msg !== 'object') {
            yield respond.error('EINVAL', 'Invalid message');
            return;
        }

        switch (msg.op) {
            case 'item': {
                // Text item - extract text and encode
                const data = msg.data as { text?: string } | undefined;
                const text = data?.text ?? '';
                writer(this.encoder.encode(text));
                break;
            }

            case 'data': {
                // Binary data - write bytes directly
                if (msg.bytes instanceof Uint8Array) {
                    writer(msg.bytes);
                }
                break;
            }

            case 'error': {
                // Error message - format and write
                const data = msg.data as { code?: string; message?: string } | undefined;
                const text = `Error: ${data?.code ?? 'UNKNOWN'}: ${data?.message ?? 'Unknown error'}\n`;
                writer(this.encoder.encode(text));
                break;
            }

            // done, ok, etc. - no output
        }

        yield respond.ok();
    }

    async close(): Promise<void> {
        this._closed = true;
    }
}
