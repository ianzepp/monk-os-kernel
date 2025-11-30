/**
 * Block Device
 *
 * Raw byte storage with offset-based access.
 * Used for virtual disk, swap, raw partitions.
 *
 * Bun touchpoints:
 * - Bun.file() for file-backed storage
 * - Bun.write() for atomic writes
 * - ArrayBuffer for in-memory storage
 *
 * Caveats:
 * - Bun.file() reads are lazy; slice() returns a Blob, not bytes
 * - No true block-level atomicity; sync() flushes but doesn't guarantee
 * - File locking is not available in Bun; concurrent access is unsafe
 */

/**
 * Block device metadata
 */
export interface BlockStat {
    /** Total size in bytes */
    size: number;
    /** Optimal I/O block size (hint for callers) */
    blocksize: number;
    /** True if writes are not permitted */
    readonly: boolean;
}

/**
 * Block device interface.
 *
 * Provides raw byte-level access to storage. All operations
 * are offset-based with no structure imposed.
 */
export interface BlockDevice {
    /**
     * Read bytes from device at offset.
     *
     * Bun: Uses Bun.file().slice().arrayBuffer()
     *
     * @param offset - Byte offset to start reading
     * @param size - Number of bytes to read
     * @returns Raw bytes (may be shorter than size at EOF)
     */
    read(offset: number, size: number): Promise<Uint8Array>;

    /**
     * Write bytes to device at offset.
     *
     * Bun: Uses Bun.write() which is atomic for whole-file writes,
     * but partial writes require read-modify-write cycles.
     *
     * Caveat: Partial writes are NOT atomic. A crash during write
     * may leave the device in an inconsistent state. Higher layers
     * must implement journaling if needed.
     *
     * @param offset - Byte offset to start writing
     * @param data - Bytes to write
     */
    write(offset: number, data: Uint8Array): Promise<void>;

    /**
     * Flush pending writes to durable storage.
     *
     * Bun: Bun.write() is already synchronous to disk on completion,
     * so this is mostly a no-op. Included for interface consistency
     * and future implementations that may buffer.
     */
    sync(): Promise<void>;

    /**
     * Get device metadata.
     */
    stat(): Promise<BlockStat>;
}

/**
 * File-backed block device using Bun.file()
 *
 * Bun touchpoints:
 * - Bun.file(path) - get file handle
 * - file.slice(start, end) - get byte range as Blob
 * - file.arrayBuffer() - read entire file
 * - Bun.write(path, data) - write file
 *
 * Caveats:
 * - No sparse file support; writing past EOF extends with zeros
 * - No file locking; concurrent access from multiple processes unsafe
 * - Partial writes require read-modify-write; not atomic
 */
export class BunBlockDevice implements BlockDevice {
    private path: string;

    constructor(path: string) {
        this.path = path;
    }

    async read(offset: number, size: number): Promise<Uint8Array> {
        const file = Bun.file(this.path);

        // Check if file exists and get size
        const exists = await file.exists();
        if (!exists) {
            return new Uint8Array(0);
        }

        const fileSize = file.size;
        if (offset >= fileSize) {
            return new Uint8Array(0);
        }

        // Clamp read to file bounds
        const end = Math.min(offset + size, fileSize);
        const slice = file.slice(offset, end);
        const buffer = await slice.arrayBuffer();
        return new Uint8Array(buffer);
    }

    async write(offset: number, data: Uint8Array): Promise<void> {
        const file = Bun.file(this.path);
        const exists = await file.exists();

        if (!exists && offset === 0) {
            // Simple case: new file, write from start
            await Bun.write(this.path, data);
            return;
        }

        // Read-modify-write for partial updates
        // Caveat: NOT atomic; crash during this sequence corrupts data
        let existing: Uint8Array;
        if (exists) {
            const buffer = await file.arrayBuffer();
            existing = new Uint8Array(buffer);
        } else {
            existing = new Uint8Array(0);
        }

        // Extend buffer if writing past current end
        const requiredSize = offset + data.length;
        let result: Uint8Array;
        if (requiredSize > existing.length) {
            result = new Uint8Array(requiredSize);
            result.set(existing);
        } else {
            result = existing;
        }

        // Apply write
        result.set(data, offset);
        await Bun.write(this.path, result);
    }

    async sync(): Promise<void> {
        // Bun.write() is synchronous to disk on completion
        // No buffering to flush
    }

    async stat(): Promise<BlockStat> {
        const file = Bun.file(this.path);
        const exists = await file.exists();

        return {
            size: exists ? file.size : 0,
            blocksize: 4096, // Common filesystem block size
            readonly: false,
        };
    }
}

/**
 * In-memory block device backed by ArrayBuffer
 *
 * Useful for:
 * - Testing (fast, no filesystem)
 * - Standalone mode with ephemeral storage
 * - Embedding small virtual disks
 *
 * Caveats:
 * - All data lost on process exit
 * - Limited by available memory
 * - No persistence
 */
export class MemoryBlockDevice implements BlockDevice {
    private buffer: Uint8Array;
    private readonly initialSize: number;

    /**
     * @param initialSize - Initial buffer size in bytes (default 1MB)
     */
    constructor(initialSize: number = 1024 * 1024) {
        this.initialSize = initialSize;
        this.buffer = new Uint8Array(initialSize);
    }

    async read(offset: number, size: number): Promise<Uint8Array> {
        if (offset >= this.buffer.length) {
            return new Uint8Array(0);
        }

        const end = Math.min(offset + size, this.buffer.length);
        // Return a copy to prevent external mutation
        return this.buffer.slice(offset, end);
    }

    async write(offset: number, data: Uint8Array): Promise<void> {
        const requiredSize = offset + data.length;

        // Grow buffer if needed (double each time)
        if (requiredSize > this.buffer.length) {
            let newSize = this.buffer.length;
            while (newSize < requiredSize) {
                newSize *= 2;
            }
            const newBuffer = new Uint8Array(newSize);
            newBuffer.set(this.buffer);
            this.buffer = newBuffer;
        }

        this.buffer.set(data, offset);
    }

    async sync(): Promise<void> {
        // No-op for memory device
    }

    async stat(): Promise<BlockStat> {
        return {
            size: this.buffer.length,
            blocksize: 4096,
            readonly: false,
        };
    }

    /**
     * Reset device to initial state.
     * Testing convenience method.
     */
    reset(): void {
        this.buffer = new Uint8Array(this.initialSize);
    }
}
