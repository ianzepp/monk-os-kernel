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

/**
 * Resource type discriminator
 */
export type ResourceType = 'file' | 'socket';

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

    constructor(
        readonly id: string,
        private socket: Socket,
        readonly description: string
    ) {}

    get closed(): boolean {
        return this._closed;
    }

    async read(_size?: number): Promise<Uint8Array> {
        // Socket.read() doesn't take a size parameter - it returns available data
        return this.socket.read();
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
     * Get socket metadata
     */
    stat(): { remoteAddr: string; remotePort: number; localAddr: string; localPort: number } {
        return this.socket.stat();
    }
}

// ============================================================================
// Port Types
// ============================================================================

// NOTE: Ports are currently owned by a single process. If we add fd/port
// passing between processes in the future, we'll need reference counting
// to avoid closing a port that's still in use by another process.
// Same issue exists for Resources above.

/**
 * Port type discriminator
 */
export type PortType = 'tcp:listen' | 'udp' | 'watch' | 'pubsub';

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
        throw new Error('EOPNOTSUPP: tcp:listen ports do not support send');
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
