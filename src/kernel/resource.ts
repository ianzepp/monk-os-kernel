/**
 * Resource
 *
 * Unified abstraction for file descriptors that can represent:
 * - VFS FileHandle (files, folders, devices)
 * - HAL Socket (TCP connections)
 *
 * All resources support read(), write(), close() with consistent semantics.
 */

import type { FileHandle } from '@src/vfs/index.js';
import type { Socket } from '@src/hal/index.js';

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
