/**
 * Resource
 *
 * Unified abstraction for file descriptors that can represent:
 * - VFS FileHandle (files, folders, devices)
 * - HAL Socket (TCP connections)
 *
 * All resources support read(), write(), close() with consistent semantics.
 *
 * Ports are message-based I/O channels for:
 * - TCP listeners (accept connections)
 * - UDP sockets (datagrams)
 * - File watchers
 * - Pub/sub messaging
 */

import type { FileHandle } from '@src/vfs/index.js';
import type { Socket, Listener } from '@src/hal/index.js';
import type { PortType } from '@src/kernel/types.js';
import { EBADF, EINVAL, ENOTSUP } from '@src/kernel/errors.js';
export type { PortType } from '@src/kernel/types.js';

/**
 * Resource type discriminator
 */
export type ResourceType = 'file' | 'socket' | 'pipe';

/**
 * Base resource interface
 */
export interface Resource {
    /** Unique resource identifier */
    readonly id: string;

    /** Resource type */
    readonly type: ResourceType;

    /** Human-readable description (path or address) */
    readonly description: string;

    /** Read data from resource */
    read(size?: number): Promise<Uint8Array>;

    /** Write data to resource */
    write(data: Uint8Array): Promise<number>;

    /** Close resource */
    close(): Promise<void>;

    /** Check if closed */
    readonly closed: boolean;
}

/**
 * File resource wrapping VFS FileHandle
 */
export class FileResource implements Resource {
    readonly type: ResourceType = 'file';
    private _closed = false;

    constructor(
        readonly id: string,
        private handle: FileHandle
    ) {}

    get description(): string {
        return this.handle.path;
    }

    get closed(): boolean {
        return this._closed || this.handle.closed;
    }

    async read(size?: number): Promise<Uint8Array> {
        return this.handle.read(size);
    }

    async write(data: Uint8Array): Promise<number> {
        return this.handle.write(data);
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.handle.close();
    }

    /**
     * Get underlying handle for VFS-specific operations
     */
    getHandle(): FileHandle {
        return this.handle;
    }
}

/**
 * Socket resource wrapping HAL Socket
 */
export class SocketResource implements Resource {
    readonly type: ResourceType = 'socket';
    private _closed = false;
    private readonly _stat: { remoteAddr: string; remotePort: number; localAddr: string; localPort: number };
    private buffer: Uint8Array = new Uint8Array(0);

    constructor(
        readonly id: string,
        private socket: Socket,
        readonly description: string
    ) {
        // Cache stat on construction - it doesn't change and socket.stat()
        // may throw or return garbage after the socket is closed
        this._stat = socket.stat();
    }

    get closed(): boolean {
        return this._closed;
    }

    async read(size?: number): Promise<Uint8Array> {
        // If we have buffered data, return from buffer first
        if (this.buffer.length > 0) {
            if (size === undefined || size >= this.buffer.length) {
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

        // If no size limit or chunk fits, return it
        if (size === undefined || chunk.length <= size) {
            return chunk;
        }

        // Return requested size, buffer the rest
        this.buffer = chunk.slice(size);
        return chunk.slice(0, size);
    }

    async write(data: Uint8Array): Promise<number> {
        await this.socket.write(data);
        return data.length;
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.socket.close();
    }

    /**
     * Get underlying socket for network-specific operations
     */
    getSocket(): Socket {
        return this.socket;
    }

    /**
     * Get socket metadata (cached, safe to call after close)
     */
    stat(): { remoteAddr: string; remotePort: number; localAddr: string; localPort: number } {
        return this._stat;
    }
}

// ============================================================================
// Port Types
// ============================================================================

// NOTE: Ports are currently owned by a single process. If we add fd/port
// passing between processes in the future, we'll need reference counting
// to avoid closing a port that's still in use by another process.
// Same issue exists for Resources above.

// PortType is defined in types.ts as the authoritative source

/**
 * Message received from a port.
 *
 * For tcp:listen: socket contains the accepted connection
 * For udp/pubsub/watch: data contains the payload
 */
export interface PortMessage {
    /** Source identifier (remote address, topic, path) */
    from: string;

    /** Payload for data ports */
    data?: Uint8Array;

    /** Accepted socket for tcp:listen */
    socket?: Socket;

    /** Optional metadata */
    meta?: Record<string, unknown>;
}

/**
 * Base port interface
 */
export interface Port {
    /** Unique port identifier */
    readonly id: string;

    /** Port type */
    readonly type: PortType;

    /** Human-readable description */
    readonly description: string;

    /** Receive next message (blocks until available) */
    recv(): Promise<PortMessage>;

    /** Send message to destination (not all ports support this) */
    send(to: string, data: Uint8Array): Promise<void>;

    /** Close port */
    close(): Promise<void>;

    /** Check if closed */
    readonly closed: boolean;
}

/**
 * Base port notes - applies to all port types:
 *
 * KNOWN ISSUES:
 * - If a process creates a port but never calls recv(), messages queue
 *   indefinitely. Future: add a timeout or max queue size.
 * - recv() blocks indefinitely with no way to interrupt. If a process is blocked
 *   in recv() when SIGTERM arrives, it can't respond gracefully. The grace period
 *   expires and SIGKILL is sent. Future: need a mechanism to cancel pending recv()
 *   calls, possibly via AbortController or a kernel-side interrupt flag.
 */

/**
 * TCP listener port
 *
 * Wraps HAL Listener to provide port interface.
 * recv() accepts connections and returns them as PortMessages with socket.
 */
export class ListenerPort implements Port {
    readonly type: PortType = 'tcp:listen';
    private _closed = false;

    constructor(
        readonly id: string,
        private listener: Listener,
        readonly description: string
    ) {}

    get closed(): boolean {
        return this._closed;
    }

    async recv(): Promise<PortMessage> {
        const socket = await this.listener.accept();
        const stat = socket.stat();
        return {
            from: `${stat.remoteAddr}:${stat.remotePort}`,
            socket,
        };
    }

    async send(_to: string, _data: Uint8Array): Promise<void> {
        throw new ENOTSUP('tcp:listen ports do not support send');
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.listener.close();
    }

    /**
     * Get listener address
     */
    addr(): { hostname: string; port: number } {
        return this.listener.addr();
    }
}

/**
 * Watch event from VFS (re-exported for kernel use)
 */
export type { WatchEvent as VfsWatchEvent } from '@src/vfs/model.js';
import type { WatchEvent } from '@src/vfs/model.js';

/**
 * Watch port
 *
 * Subscribes to VFS file system events and delivers them as port messages.
 * Pattern supports glob-style matching:
 * - `/users/*` - direct children of /users
 * - `/users/**` - all descendants of /users
 * - `/users/123` - exact path
 */
export class WatchPort implements Port {
    readonly type: PortType = 'watch';
    private _closed = false;
    private messageQueue: PortMessage[] = [];
    private waiters: Array<(msg: PortMessage) => void> = [];
    private vfsIterator: AsyncIterator<WatchEvent> | null = null;
    private iteratorDone = false;

    constructor(
        readonly id: string,
        private pattern: string,
        private vfsWatch: (pattern: string) => AsyncIterable<WatchEvent>,
        readonly description: string
    ) {
        // Start consuming VFS events in background
        this.startConsuming();
    }

    get closed(): boolean {
        return this._closed;
    }

    /**
     * Start consuming events from VFS and queuing/delivering them
     */
    private async startConsuming(): Promise<void> {
        try {
            const iterable = this.vfsWatch(this.pattern);
            this.vfsIterator = iterable[Symbol.asyncIterator]();

            while (!this._closed) {
                const result = await this.vfsIterator.next();
                if (result.done) {
                    this.iteratorDone = true;
                    break;
                }

                const event = result.value;
                const message: PortMessage = {
                    from: event.path,
                    data: new TextEncoder().encode(JSON.stringify({
                        entity: event.entity,
                        op: event.op,
                        fields: event.fields,
                    })),
                    meta: {
                        op: event.op,
                        entity: event.entity,
                        fields: event.fields,
                        timestamp: event.timestamp,
                    },
                };

                // If someone is waiting, deliver directly
                if (this.waiters.length > 0) {
                    const waiter = this.waiters.shift()!;
                    waiter(message);
                } else {
                    this.messageQueue.push(message);
                }
            }
        } catch (error) {
            // If closed, ignore errors
            if (!this._closed) {
                console.error('WatchPort error:', error);
            }
        }
    }

    async recv(): Promise<PortMessage> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        // If we have queued messages, return one
        if (this.messageQueue.length > 0) {
            return this.messageQueue.shift()!;
        }

        // If iterator is done and no queued messages, throw
        if (this.iteratorDone) {
            throw new Error('EOF: No more events');
        }

        // Wait for next message
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    async send(_to: string, _data: Uint8Array): Promise<void> {
        throw new ENOTSUP('watch ports do not support send');
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        // Clear waiters (they will receive nothing - port closed)
        this.waiters = [];
        this.messageQueue = [];
    }
}

/**
 * UDP socket options
 */
export interface UdpSocketOpts {
    /** Local port to bind */
    bind: number;
    /** Local address (default: 0.0.0.0) */
    address?: string;
}

/**
 * Bun UDP socket interface
 *
 * Typed interface for Bun.udpSocket() return value.
 * When Bun's types stabilize, mismatches will surface as compile errors.
 */
interface BunUdpSocket {
    /** Send datagram to remote host:port */
    send(data: Uint8Array, port: number, host: string): number;
    /** Close the socket */
    close(): void;
}

/**
 * UDP port
 *
 * Send and receive UDP datagrams.
 * Each recv() returns a message with the sender's address in `from`.
 * send() requires a destination address in "host:port" format.
 */
export class UdpPort implements Port {
    readonly type: PortType = 'udp';
    private _closed = false;
    private messageQueue: PortMessage[] = [];
    private waiters: Array<(msg: PortMessage) => void> = [];
    private socket: BunUdpSocket | null = null;

    constructor(
        readonly id: string,
        private opts: UdpSocketOpts,
        readonly description: string
    ) {
        this.startListening();
    }

    get closed(): boolean {
        return this._closed;
    }

    /**
     * Start listening for UDP datagrams
     */
    private startListening(): void {
        const self = this;

        this.socket = Bun.udpSocket({
            port: this.opts.bind,
            hostname: this.opts.address ?? '0.0.0.0',

            socket: {
                data(_socket, buf, port, addr) {
                    const message: PortMessage = {
                        from: `${addr}:${port}`,
                        data: new Uint8Array(buf),
                    };

                    if (self.waiters.length > 0) {
                        const waiter = self.waiters.shift()!;
                        waiter(message);
                    } else {
                        self.messageQueue.push(message);
                    }
                },
                error(_socket, error) {
                    console.error('UDP socket error:', error);
                },
            },
        }) as unknown as BunUdpSocket;
    }

    async recv(): Promise<PortMessage> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        // If we have queued messages, return one
        if (this.messageQueue.length > 0) {
            return this.messageQueue.shift()!;
        }

        // Wait for next message
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    async send(to: string, data: Uint8Array): Promise<void> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        // Parse "host:port" format
        const lastColon = to.lastIndexOf(':');
        if (lastColon === -1) {
            throw new EINVAL('Invalid address format, expected host:port');
        }

        const host = to.slice(0, lastColon);
        const port = parseInt(to.slice(lastColon + 1), 10);

        if (isNaN(port)) {
            throw new EINVAL('Invalid port number');
        }

        if (!this.socket) {
            throw new EBADF('Socket not initialized');
        }
        this.socket.send(data, port, host);
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }

        this.waiters = [];
        this.messageQueue = [];
    }
}

// ============================================================================
// Pubsub Types
// ============================================================================

/**
 * Pubsub port
 *
 * Topic-based publish/subscribe messaging.
 * recv() blocks until a message arrives on a subscribed topic.
 * send() publishes to a topic (delivered to all matching subscribers).
 *
 * Topic patterns:
 * - `orders.created` - exact topic
 * - `orders.*` - one level wildcard
 * - `orders.>` - multi-level wildcard (all under orders)
 */
export class PubsubPort implements Port {
    readonly type: PortType = 'pubsub';
    private _closed = false;
    private messageQueue: PortMessage[] = [];
    private waiters: Array<(msg: PortMessage) => void> = [];

    constructor(
        readonly id: string,
        private patterns: string[],
        private publishFn: (topic: string, data: Uint8Array, sourcePortId: string) => void,
        private unsubscribeFn: () => void,
        readonly description: string
    ) {}

    get closed(): boolean {
        return this._closed;
    }

    /**
     * Get subscribed patterns
     */
    getPatterns(): string[] {
        return this.patterns;
    }

    /**
     * Enqueue a message (called by kernel when topic matches)
     */
    enqueue(msg: PortMessage): void {
        if (this._closed) return;

        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!;
            waiter(msg);
        } else {
            this.messageQueue.push(msg);
        }
    }

    async recv(): Promise<PortMessage> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        if (this.messageQueue.length > 0) {
            return this.messageQueue.shift()!;
        }

        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    async send(topic: string, data: Uint8Array): Promise<void> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        this.publishFn(topic, data, this.id);
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        this.unsubscribeFn();
        this.waiters = [];
        this.messageQueue = [];
    }
}

/**
 * Match a topic against a pattern.
 *
 * Pattern syntax:
 * - `orders.created` - exact match
 * - `orders.*` - matches one segment (e.g., orders.created, orders.deleted)
 * - `orders.>` - matches one or more segments (e.g., orders.us.created)
 */
export function matchTopic(pattern: string, topic: string): boolean {
    const patternParts = pattern.split('.');
    const topicParts = topic.split('.');

    for (let i = 0; i < patternParts.length; i++) {
        const p = patternParts[i];

        // Multi-level wildcard - matches one or more remaining segments
        if (p === '>') {
            return topicParts.length > i; // Must have at least one segment after this position
        }

        // No more topic parts but pattern continues
        if (i >= topicParts.length) {
            return false;
        }

        // Single-level wildcard - matches any single segment
        if (p === '*') {
            continue;
        }

        // Exact match required
        if (p !== topicParts[i]) {
            return false;
        }
    }

    // Pattern exhausted - topic must also be exhausted
    return patternParts.length === topicParts.length;
}

// ============================================================================
// Pipe Types
// ============================================================================

/**
 * Pipe end type
 */
export type PipeEnd = 'read' | 'write';

/**
 * Shared buffer for pipe communication
 *
 * Provides in-memory buffering between read and write ends of a pipe.
 * Supports blocking reads when buffer is empty and EOF detection.
 */
export class PipeBuffer {
    private chunks: Uint8Array[] = [];
    private totalBytes = 0;
    private writeEndClosed = false;
    private readEndClosed = false;
    private waiters: Array<{ resolve: (data: Uint8Array) => void; reject: (err: Error) => void }> = [];

    /**
     * Write data to the buffer
     *
     * @throws EPIPE if read end is closed
     */
    write(data: Uint8Array): number {
        if (this.readEndClosed) {
            // Import dynamically to avoid circular dependency
            const { EPIPE } = require('@src/hal/errors.js');
            throw new EPIPE('Read end closed');
        }

        if (data.length === 0) return 0;

        // If there are waiters, give data to the first one directly
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!;
            waiter.resolve(data);
            return data.length;
        }

        // Otherwise buffer it
        this.chunks.push(data);
        this.totalBytes += data.length;
        return data.length;
    }

    /**
     * Read data from the buffer
     *
     * Blocks if buffer is empty and write end is open.
     * Returns empty array on EOF (write end closed, buffer empty).
     */
    async read(size?: number): Promise<Uint8Array> {
        // If we have data, return it
        if (this.chunks.length > 0) {
            return this.consumeChunks(size);
        }

        // No data - if write end closed, return EOF
        if (this.writeEndClosed) {
            return new Uint8Array(0);
        }

        // Block until data available or EOF
        return new Promise((resolve, reject) => {
            this.waiters.push({ resolve, reject });
        });
    }

    /**
     * Consume buffered chunks
     */
    private consumeChunks(size?: number): Uint8Array {
        if (this.chunks.length === 0) {
            return new Uint8Array(0);
        }

        // If no size limit or only one chunk, return all
        if (size === undefined || this.chunks.length === 1) {
            const result = this.mergeChunks();
            this.chunks = [];
            this.totalBytes = 0;
            return result;
        }

        // Consume up to size bytes
        const result: Uint8Array[] = [];
        let remaining = size;

        while (remaining > 0 && this.chunks.length > 0) {
            const chunk = this.chunks[0]!; // Safe: checked length > 0
            if (chunk.length <= remaining) {
                result.push(chunk);
                remaining -= chunk.length;
                this.totalBytes -= chunk.length;
                this.chunks.shift();
            } else {
                // Split chunk
                result.push(chunk.slice(0, remaining));
                this.chunks[0] = chunk.slice(remaining);
                this.totalBytes -= remaining;
                remaining = 0;
            }
        }

        return this.mergeArrays(result);
    }

    /**
     * Merge all chunks into single array
     */
    private mergeChunks(): Uint8Array {
        if (this.chunks.length === 1) {
            return this.chunks[0]!; // Safe: checked length === 1
        }
        return this.mergeArrays(this.chunks);
    }

    /**
     * Merge arrays into single array
     */
    private mergeArrays(arrays: Uint8Array[]): Uint8Array {
        if (arrays.length === 0) return new Uint8Array(0);
        if (arrays.length === 1) return arrays[0]!; // Safe: checked length === 1

        const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const arr of arrays) {
            result.set(arr, offset);
            offset += arr.length;
        }
        return result;
    }

    /**
     * Close write end - signals EOF to readers
     */
    closeWriteEnd(): void {
        if (this.writeEndClosed) return;
        this.writeEndClosed = true;

        // Wake all waiters with EOF
        for (const waiter of this.waiters) {
            waiter.resolve(new Uint8Array(0));
        }
        this.waiters = [];
    }

    /**
     * Close read end - causes EPIPE on writes
     */
    closeReadEnd(): void {
        if (this.readEndClosed) return;
        this.readEndClosed = true;

        // Clear buffer since nobody will read it
        this.chunks = [];
        this.totalBytes = 0;

        // Reject any pending waiters (shouldn't happen, but be safe)
        const { EPIPE } = require('@src/hal/errors.js');
        for (const waiter of this.waiters) {
            waiter.reject(new EPIPE('Read end closed'));
        }
        this.waiters = [];
    }

    /**
     * Check if both ends are closed
     */
    get fullyClosed(): boolean {
        return this.writeEndClosed && this.readEndClosed;
    }

    /**
     * Get buffer size (for debugging)
     */
    get size(): number {
        return this.totalBytes;
    }
}

/**
 * Pipe resource
 *
 * Represents one end of a pipe. Two PipeResources share a PipeBuffer.
 * Read end can only read, write end can only write.
 */
export class PipeResource implements Resource {
    readonly type: ResourceType = 'pipe';
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

    async read(size?: number): Promise<Uint8Array> {
        if (this._closed) {
            const { EBADF } = require('@src/hal/errors.js');
            throw new EBADF('Pipe closed');
        }
        if (this.end !== 'read') {
            const { EBADF } = require('@src/hal/errors.js');
            throw new EBADF('Cannot read from write end of pipe');
        }
        return this.buffer.read(size);
    }

    async write(data: Uint8Array): Promise<number> {
        if (this._closed) {
            const { EBADF } = require('@src/hal/errors.js');
            throw new EBADF('Pipe closed');
        }
        if (this.end !== 'write') {
            const { EBADF } = require('@src/hal/errors.js');
            throw new EBADF('Cannot write to read end of pipe');
        }
        return this.buffer.write(data);
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
