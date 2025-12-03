/**
 * File Handle Adapter
 *
 * Wraps VFS FileHandle in the unified handle interface.
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { FileHandle as VfsFileHandle, SeekWhence } from '@src/vfs/index.js';
import { DEFAULT_CHUNK_SIZE, MAX_STREAM_BYTES } from '@src/kernel/types.js';
import type { Handle, HandleType } from './types.js';

/**
 * File handle operations
 */
type FileOp = 'recv' | 'send' | 'seek' | 'stat';

/**
 * File handle wrapping VFS FileHandle.
 *
 * Supported ops:
 * - recv: Stream chunks until EOF
 * - send: Write data, return bytes written
 * - seek: Seek to position
 * - stat: Get file metadata
 */
export class FileHandleAdapter implements Handle {
    readonly type: HandleType = 'file';
    private _closed = false;

    constructor(
        readonly id: string,
        private handle: VfsFileHandle
    ) {}

    get description(): string {
        return this.handle.path;
    }

    get closed(): boolean {
        return this._closed || this.handle.closed;
    }

    async *exec(msg: Message): AsyncIterable<Response> {
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
                yield* this.seek(
                    data?.offset as number,
                    data?.whence as SeekWhence
                );
                break;

            case 'stat':
                yield* this.stat();
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
                const chunk = await this.handle.read(size);

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

                // Short read indicates EOF
                if (chunk.length < size) {
                    break;
                }
            }

            yield respond.done();
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    private encoder = new TextEncoder();

    /**
     * Write data to file.
     *
     * Accepts:
     * - { data: Uint8Array } from write() syscall
     * - Response item from send() syscall (for redirected stdout)
     */
    private async *send(data: unknown): AsyncIterable<Response> {
        let bytes: Uint8Array;

        // Handle different input formats
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
                } else if (response.op === 'chunk') {
                    // Binary chunk - use directly
                    const chunkData = response.data as { bytes?: Uint8Array } | undefined;
                    bytes = chunkData?.bytes ?? new Uint8Array(0);
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
            const written = await this.handle.write(bytes);
            yield respond.ok({ written });
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    private async *seek(offset: number, whence?: SeekWhence): AsyncIterable<Response> {
        if (typeof offset !== 'number') {
            yield respond.error('EINVAL', 'offset must be a number');
            return;
        }

        try {
            const pos = await this.handle.seek(offset, whence ?? 'start');
            yield respond.ok(pos);
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    private async *stat(): AsyncIterable<Response> {
        try {
            // VFS FileHandle has entity info
            yield respond.ok({
                path: this.handle.path,
                // Additional stat info would come from VFS
            });
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.handle.close();
    }

    /**
     * Get underlying VFS handle (for kernel-internal operations)
     */
    getHandle(): VfsFileHandle {
        return this.handle;
    }
}
