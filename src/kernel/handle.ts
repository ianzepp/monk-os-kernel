/**
 * Unified Handle Architecture
 *
 * All I/O primitives (files, sockets, pipes, ports, channels) are handles.
 * A single `send(handle, msg)` syscall dispatches to the handle type.
 *
 * Philosophy:
 * - Everything is a handle with send(Message) → AsyncIterable<Response>
 * - Handle types define supported operations
 * - Userspace API unchanged - this is kernel-internal unification
 *
 * Handle Types:
 * - file: VFS files, folders, devices
 * - socket: TCP connections
 * - pipe: In-memory pipes between processes
 * - port: Message-based I/O (listeners, watchers, pubsub)
 * - channel: Protocol-aware connections (HTTP, WebSocket, PostgreSQL)
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { FileHandle as VfsFileHandle, SeekWhence } from '@src/vfs/index.js';
import type { Socket } from '@src/hal/network.js';
import type { Channel } from '@src/hal/channel.js';
import { DEFAULT_CHUNK_SIZE, MAX_STREAM_BYTES } from '@src/kernel/types.js';

/**
 * Handle type discriminator
 */
export type HandleType = 'file' | 'socket' | 'pipe' | 'port' | 'channel' | 'process-io';

/**
 * Unified handle interface.
 *
 * All I/O primitives implement this interface, providing message-based
 * operations via send(). The kernel dispatches based on handle type.
 */
export interface Handle {
    /** Unique handle identifier */
    readonly id: string;

    /** Handle type for dispatch */
    readonly type: HandleType;

    /** Human-readable description (path, address, protocol) */
    readonly description: string;

    /** Whether the handle is closed */
    readonly closed: boolean;

    /**
     * Send a message to the handle and receive streaming responses.
     *
     * @param msg - Message containing operation and data
     * @returns Async iterable of responses
     */
    send(msg: Message): AsyncIterable<Response>;

    /**
     * Close the handle and release resources.
     */
    close(): Promise<void>;
}

// ============================================================================
// File Handle (wraps VFS FileHandle)
// ============================================================================

/**
 * File handle operations
 */
type FileOp = 'read' | 'write' | 'seek' | 'stat';

/**
 * File handle wrapping VFS FileHandle.
 *
 * Supported ops:
 * - read: Stream chunks until EOF
 * - write: Write data, return bytes written
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

    async *send(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op as FileOp;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'read':
                yield* this.read(data?.chunkSize as number | undefined);
                break;

            case 'write':
                yield* this.write(data?.data as Uint8Array);
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

    private async *read(chunkSize?: number): AsyncIterable<Response> {
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

                yield respond.item(chunk);

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

    private async *write(data: Uint8Array): AsyncIterable<Response> {
        if (!(data instanceof Uint8Array)) {
            yield respond.error('EINVAL', 'data must be Uint8Array');
            return;
        }

        try {
            const written = await this.handle.write(data);
            yield respond.ok(written);
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

// ============================================================================
// Socket Handle (wraps HAL Socket)
// ============================================================================

/**
 * Socket handle wrapping HAL Socket.
 *
 * Supported ops:
 * - read: Stream chunks until EOF
 * - write: Write data
 * - stat: Get socket metadata
 */
export class SocketHandleAdapter implements Handle {
    readonly type: HandleType = 'socket';
    private _closed = false;
    private buffer: Uint8Array = new Uint8Array(0);
    private readonly _stat: { remoteAddr: string; remotePort: number; localAddr: string; localPort: number };

    constructor(
        readonly id: string,
        private socket: Socket,
        readonly description: string
    ) {
        // Cache stat on construction
        this._stat = socket.stat();
    }

    get closed(): boolean {
        return this._closed;
    }

    async *send(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'read':
                yield* this.read(data?.chunkSize as number | undefined);
                break;

            case 'write':
                yield* this.write(data?.data as Uint8Array);
                break;

            case 'stat':
                yield respond.ok(this._stat);
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    private async *read(chunkSize?: number): AsyncIterable<Response> {
        const size = chunkSize ?? DEFAULT_CHUNK_SIZE;
        let totalYielded = 0;

        try {
            while (true) {
                const chunk = await this.readChunk(size);

                // EOF
                if (chunk.length === 0) {
                    break;
                }

                totalYielded += chunk.length;
                if (totalYielded > MAX_STREAM_BYTES) {
                    yield respond.error('EFBIG', `Read stream exceeded ${MAX_STREAM_BYTES} bytes`);
                    return;
                }

                yield respond.item(chunk);
            }

            yield respond.done();
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    private async readChunk(size: number): Promise<Uint8Array> {
        // If we have buffered data, return from buffer first
        if (this.buffer.length > 0) {
            if (size >= this.buffer.length) {
                const data = this.buffer;
                this.buffer = new Uint8Array(0);
                return data;
            }
            const data = this.buffer.slice(0, size);
            this.buffer = this.buffer.slice(size);
            return data;
        }

        // Read from socket
        const chunk = await this.socket.read();
        if (chunk.length === 0) {
            return chunk; // EOF
        }

        // If chunk fits, return it
        if (chunk.length <= size) {
            return chunk;
        }

        // Return requested size, buffer the rest
        this.buffer = chunk.slice(size);
        return chunk.slice(0, size);
    }

    private async *write(data: Uint8Array): AsyncIterable<Response> {
        if (!(data instanceof Uint8Array)) {
            yield respond.error('EINVAL', 'data must be Uint8Array');
            return;
        }

        try {
            await this.socket.write(data);
            yield respond.ok(data.length);
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.socket.close();
    }

    /**
     * Get underlying socket (for kernel-internal operations)
     */
    getSocket(): Socket {
        return this.socket;
    }

    /**
     * Get cached socket metadata
     */
    stat(): { remoteAddr: string; remotePort: number; localAddr: string; localPort: number } {
        return this._stat;
    }
}

// ============================================================================
// Pipe Handle (wraps shared PipeBuffer)
// ============================================================================

import { PipeBuffer } from '@src/kernel/resource.js';

/**
 * Pipe end type
 */
export type PipeEnd = 'read' | 'write';

/**
 * Pipe handle wrapping shared PipeBuffer.
 *
 * Supported ops:
 * - read: Read from pipe (read end only)
 * - write: Write to pipe (write end only)
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

    async *send(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'read':
                if (this.end !== 'read') {
                    yield respond.error('EBADF', 'Cannot read from write end of pipe');
                    return;
                }
                yield* this.read(data?.chunkSize as number | undefined);
                break;

            case 'write':
                if (this.end !== 'write') {
                    yield respond.error('EBADF', 'Cannot write to read end of pipe');
                    return;
                }
                yield* this.write(data?.data as Uint8Array);
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    private async *read(chunkSize?: number): AsyncIterable<Response> {
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

                yield respond.item(chunk);
            }

            yield respond.done();
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    private async *write(data: Uint8Array): AsyncIterable<Response> {
        if (!(data instanceof Uint8Array)) {
            yield respond.error('EINVAL', 'data must be Uint8Array');
            return;
        }

        try {
            const written = this.buffer.write(data);
            yield respond.ok(written);
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

// ============================================================================
// Port Handle (wraps Port)
// ============================================================================

import type { Port } from '@src/kernel/resource.js';

/**
 * Port handle wrapping Port (listeners, watchers, pubsub).
 *
 * Supported ops:
 * - recv: Receive next message (blocks until available)
 * - send: Send message to destination (pubsub, UDP)
 * - stat: Get port info
 *
 * Note: For tcp:listen ports, recv returns socket info, and the kernel
 * needs to wrap the socket into a new handle for the caller.
 */
export class PortHandleAdapter implements Handle {
    readonly type: HandleType = 'port';
    private _closed = false;

    constructor(
        readonly id: string,
        private port: Port,
        readonly description: string
    ) {}

    get closed(): boolean {
        return this._closed || this.port.closed;
    }

    async *send(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'recv':
                yield* this.recv();
                break;

            case 'send':
                yield* this.portSend(
                    data?.to as string,
                    data?.data as Uint8Array
                );
                break;

            case 'stat':
                yield respond.ok({
                    type: this.port.type,
                    description: this.description,
                });
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    private async *recv(): AsyncIterable<Response> {
        try {
            const msg = await this.port.recv();
            yield respond.ok(msg);
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    private async *portSend(to: string, data: Uint8Array): AsyncIterable<Response> {
        if (typeof to !== 'string') {
            yield respond.error('EINVAL', 'to must be a string');
            return;
        }
        if (!(data instanceof Uint8Array)) {
            yield respond.error('EINVAL', 'data must be Uint8Array');
            return;
        }

        try {
            await this.port.send(to, data);
            yield respond.ok();
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.port.close();
    }

    /**
     * Get underlying port (for kernel-internal operations like socket allocation)
     */
    getPort(): Port {
        return this.port;
    }

    /**
     * Get port type
     */
    getPortType(): string {
        return this.port.type;
    }
}

// ============================================================================
// Channel Handle (wraps HAL Channel)
// ============================================================================

/**
 * Channel handle wrapping HAL Channel.
 *
 * Channels already have handle(msg) → AsyncIterable<Response>, so this
 * adapter is thin - it just delegates to the channel.
 *
 * Supported ops:
 * - call: Send message, receive single response
 * - stream: Send message, receive streaming response
 * - push: Push response (server-side)
 * - recv: Receive message (bidirectional)
 */
export class ChannelHandleAdapter implements Handle {
    readonly type: HandleType = 'channel';
    private _closed = false;

    constructor(
        readonly id: string,
        private channel: Channel,
        readonly description: string
    ) {}

    get closed(): boolean {
        return this._closed || this.channel.closed;
    }

    async *send(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'call':
                // Send inner message, take first response
                for await (const response of this.channel.handle(data?.msg as Message)) {
                    yield response;
                    if (response.op === 'ok' || response.op === 'error' || response.op === 'done') {
                        return;
                    }
                }
                yield respond.error('EIO', 'No response from channel');
                break;

            case 'stream':
                // Send inner message, yield all responses
                yield* this.channel.handle(data?.msg as Message);
                break;

            case 'push':
                // Push response (server-side)
                try {
                    await this.channel.push(data?.response as Response);
                    yield respond.ok();
                } catch (err) {
                    yield respond.error('EIO', (err as Error).message);
                }
                break;

            case 'recv':
                // Receive message (bidirectional)
                try {
                    const recvMsg = await this.channel.recv();
                    yield respond.ok(recvMsg);
                } catch (err) {
                    yield respond.error('EIO', (err as Error).message);
                }
                break;

            default:
                // Forward other ops directly to channel
                yield* this.channel.handle(msg);
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.channel.close();
    }

    /**
     * Get underlying channel (for kernel-internal operations)
     */
    getChannel(): Channel {
        return this.channel;
    }

    /**
     * Get channel protocol
     */
    getProto(): string {
        return this.channel.proto;
    }
}

// ============================================================================
// Process I/O Handle (mediates process stdin/stdout/stderr)
// ============================================================================

/**
 * Process I/O handle that mediates between a process and its I/O destinations.
 *
 * Acts like shell redirects (| > >> <) but at the handle level, controlled
 * by the kernel rather than the shell. Enables:
 * - Routing process output to different destinations
 * - Tapping process I/O for observation (tee behavior)
 * - Injecting input from external sources
 *
 * Supported ops:
 * - read: Read from source handle
 * - write: Write to target handle + all taps
 * - stat: Get handle info
 *
 * The process sees a normal handle. The kernel controls where data flows.
 */
export class ProcessIOHandle implements Handle {
    readonly type: HandleType = 'process-io';
    private _closed = false;

    /** Where writes go */
    private target: Handle | null;

    /** Where reads come from */
    private source: Handle | null;

    /** Handles that receive copies of all writes (tee behavior) */
    private taps: Set<Handle> = new Set();

    constructor(
        readonly id: string,
        readonly description: string,
        opts?: {
            target?: Handle;
            source?: Handle;
        }
    ) {
        this.target = opts?.target ?? null;
        this.source = opts?.source ?? null;
    }

    get closed(): boolean {
        return this._closed;
    }

    /**
     * Set the target handle (where writes go).
     */
    setTarget(handle: Handle | null): void {
        this.target = handle;
    }

    /**
     * Get the current target handle.
     */
    getTarget(): Handle | null {
        return this.target;
    }

    /**
     * Set the source handle (where reads come from).
     */
    setSource(handle: Handle | null): void {
        this.source = handle;
    }

    /**
     * Get the current source handle.
     */
    getSource(): Handle | null {
        return this.source;
    }

    /**
     * Add a tap handle (receives copies of writes).
     */
    addTap(handle: Handle): void {
        this.taps.add(handle);
    }

    /**
     * Remove a tap handle.
     */
    removeTap(handle: Handle): void {
        this.taps.delete(handle);
    }

    /**
     * Get all tap handles.
     */
    getTaps(): Set<Handle> {
        return this.taps;
    }

    async *send(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;

        switch (op) {
            case 'read':
                yield* this.read(msg);
                break;

            case 'write':
                yield* this.write(msg);
                break;

            case 'stat':
                yield respond.ok({
                    type: 'process-io',
                    description: this.description,
                    hasTarget: this.target !== null,
                    hasSource: this.source !== null,
                    tapCount: this.taps.size,
                });
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    private async *read(msg: Message): AsyncIterable<Response> {
        if (!this.source) {
            yield respond.error('EBADF', 'No source configured for reading');
            return;
        }

        // Forward read to source
        yield* this.source.send(msg);
    }

    private async *write(msg: Message): AsyncIterable<Response> {
        if (!this.target) {
            yield respond.error('EBADF', 'No target configured for writing');
            return;
        }

        // Send to target
        const responses: Response[] = [];
        for await (const response of this.target.send(msg)) {
            responses.push(response);
        }

        // Tee to all taps (fire and forget, don't block on taps)
        for (const tap of this.taps) {
            // Run tap writes concurrently, ignore errors
            (async () => {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for await (const _ of tap.send(msg)) {
                        // Drain tap responses
                    }
                } catch {
                    // Tap errors don't affect main write
                }
            })();
        }

        // Yield original target responses
        for (const response of responses) {
            yield response;
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        // Note: We don't close target/source/taps here.
        // They may be shared with other handles.
        // The kernel manages their lifecycle.
        this.target = null;
        this.source = null;
        this.taps.clear();
    }
}
