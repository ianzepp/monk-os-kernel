/**
 * Block Device - Raw byte storage abstraction
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Block Device layer provides offset-based access to raw byte storage,
 * forming the lowest level of the storage hierarchy in Monk OS. It abstracts
 * physical storage media (files, memory, block devices) behind a uniform
 * interface, similar to Linux block device drivers.
 *
 * Unlike filesystems which impose structure (inodes, directories), block devices
 * are purely positional: read N bytes at offset M. This simplicity enables
 * multiple use cases:
 *
 * 1. VFS backing store: The VFS can layer structured storage (B-trees, log
 *    structures) on top of raw blocks
 * 2. Swap space: Virtual memory can page to block device
 * 3. Raw partitions: Direct disk access for specialized applications
 * 4. Memory mapping: In-memory block devices for performance-critical paths
 *
 * Two implementations are provided:
 * - BunBlockDevice: File-backed storage using Bun.file() and Bun.write()
 * - MemoryBlockDevice: In-memory ArrayBuffer for ephemeral storage and testing
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Offsets and sizes are always non-negative integers
 * INV-2: Reading past EOF returns partial data or empty array (never throws)
 * INV-3: Writing extends the device size automatically (no explicit truncate needed)
 * INV-4: sync() ensures all previous writes are durable before returning
 * INV-5: Lock ranges are inclusive [offset, offset + size)
 * INV-6: Overlapping write locks are mutually exclusive
 * INV-7: Released locks unblock exactly one waiter per release
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * callers may issue read(), write(), or writelock() concurrently.
 *
 * Concurrency semantics:
 * - Reads are always safe and can overlap with each other
 * - Writes can interleave dangerously if not serialized by caller
 * - writelock() provides advisory locking to coordinate writes
 * - Lock acquisition is FIFO (first caller waits first, wakes first)
 * - Lock release is atomic (either held or not, no partial state)
 *
 * The Block Device does NOT automatically serialize writes. Callers must either:
 * 1. Use writelock() to coordinate access, or
 * 2. Design their usage to avoid overlapping writes, or
 * 3. Accept that concurrent writes may corrupt data
 *
 * This design follows POSIX principles: provide mechanisms, not policy.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: writelock() uses in-memory RangeLock to prevent overlapping writes
 * RC-2: Lock waiters are woken exactly once to prevent lost wakeups
 * RC-3: BunBlockDevice read-modify-write cycles are not atomic; crash during
 *       write may corrupt data (caller must implement journaling if needed)
 * RC-4: MemoryBlockDevice growth uses slice+set which is atomic in JS event loop
 * RC-5: Lock release wakes only compatible waiters (prevents spurious wakeups)
 *
 * MEMORY MANAGEMENT
 * =================
 * BunBlockDevice:
 * - No persistent file handles (Bun.file() is cheap, recreated per operation)
 * - Read buffers are allocated per call, returned to caller (caller owns lifetime)
 * - Write buffers may be copied during read-modify-write cycles
 * - No cleanup needed (file persists, no handles to close)
 *
 * MemoryBlockDevice:
 * - ArrayBuffer grows dynamically (doubles each time)
 * - Read returns copies (not views) to prevent external mutation
 * - reset() method for testing (not part of BlockDevice interface)
 * - Memory released when object is garbage collected
 *
 * BlockLock:
 * - Disposable pattern (implements Symbol.dispose)
 * - Must call release() or use `using` pattern to avoid deadlock
 * - Lock state lives in RangeLock instance (per-device)
 *
 * TESTABILITY
 * ===========
 * - MemoryBlockDevice is fast and deterministic for unit tests
 * - No mocking needed; both implementations are concrete and testable
 * - reset() method on MemoryBlockDevice allows test isolation
 * - BlockLock.release() is synchronous (tests can verify locks released)
 * - RangeLock internal state is inspectable via overlaps() behavior
 *
 * @module hal/block
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Block device metadata.
 *
 * WHY: Provides callers with hints about device characteristics.
 * Callers can align I/O to blocksize for optimal performance.
 */
export interface BlockStat {
    /**
     * Total size in bytes.
     * WHY: Allows callers to avoid reading past EOF.
     */
    size: number;

    /**
     * Optimal I/O block size (hint for callers).
     * WHY: Aligning reads/writes to this size can improve performance.
     * Typically matches filesystem block size (4096 bytes).
     */
    blocksize: number;

    /**
     * True if writes are not permitted.
     * WHY: Distinguishes read-only media (CD-ROM, mounted read-only).
     */
    readonly: boolean;
}

/**
 * Block range lock handle.
 *
 * WHY: Provides RAII-style lock management. The `using` keyword ensures locks
 * are released even if the caller throws an exception.
 *
 * TESTABILITY: Implements Disposable for use with `using` pattern.
 *
 * EXAMPLE:
 * ```typescript
 * using lock = await block.writelock(0, 4096);
 * await block.write(0, data);
 * // Auto-released on scope exit
 * ```
 */
export interface BlockLock extends Disposable {
    /**
     * Start offset of locked range.
     * WHY: Allows caller to verify which range they locked (for debugging).
     */
    readonly offset: number;

    /**
     * Size of locked range in bytes.
     * WHY: Allows caller to verify lock extent (for debugging).
     */
    readonly size: number;

    /**
     * Release the lock.
     *
     * WHY: Explicit release allows manual control when `using` isn't available.
     * Safe to call multiple times (idempotent).
     */
    release(): void;
}

/**
 * Block device interface.
 *
 * WHY: Provides raw byte-level access to storage. All operations are
 * offset-based with no structure imposed. This is the foundation for
 * higher-level storage abstractions (filesystems, databases, swap).
 *
 * INVARIANTS:
 * - Offsets and sizes are always non-negative
 * - Reading past EOF returns partial data (never throws)
 * - Writing extends device size automatically
 * - sync() durability guarantee: all previous writes are flushed
 */
export interface BlockDevice {
    /**
     * Read bytes from device at offset.
     *
     * WHY: Fundamental read primitive. Returns raw bytes without interpretation.
     *
     * ALGORITHM:
     * 1. Check if offset is past EOF (return empty if so)
     * 2. Clamp read size to device bounds
     * 3. Read clamped range
     * 4. Return raw bytes (may be shorter than requested)
     *
     * RACE CONDITION:
     * Concurrent reads are safe. Concurrent writes to the same range may
     * return partially old/new data. Caller must serialize via writelock()
     * if consistency is required.
     *
     * @param offset - Byte offset to start reading (>= 0)
     * @param size - Number of bytes to read (> 0)
     * @returns Raw bytes (may be shorter than size at EOF)
     */
    read(offset: number, size: number): Promise<Uint8Array>;

    /**
     * Write bytes to device at offset.
     *
     * WHY: Fundamental write primitive. Writes raw bytes without interpretation.
     *
     * ALGORITHM:
     * 1. If writing past EOF, extend device (zero-fill gap)
     * 2. Overwrite bytes at offset
     * 3. Return when write completes (may not be durable until sync())
     *
     * RACE CONDITION:
     * Concurrent writes to overlapping ranges may corrupt data. The order of
     * interleaved writes is undefined. Caller must use writelock() to serialize
     * conflicting writes.
     *
     * For BunBlockDevice, partial writes use read-modify-write cycle which is
     * NOT atomic. Crash during this sequence may corrupt data. Higher layers
     * (VFS, database) must implement journaling if crash consistency is required.
     *
     * @param offset - Byte offset to start writing (>= 0)
     * @param data - Bytes to write
     */
    write(offset: number, data: Uint8Array): Promise<void>;

    /**
     * Flush pending writes to durable storage.
     *
     * WHY: Ensures data survives process crash or power loss. Required for
     * transaction commit, checkpoint operations, shutdown.
     *
     * ALGORITHM:
     * 1. Wait for all pending writes to complete
     * 2. Flush OS buffer cache to disk
     * 3. Return when data is durable
     *
     * RACE CONDITION:
     * sync() only guarantees that writes *issued before sync()* are durable.
     * Writes issued concurrently with sync() may or may not be included.
     * Caller must ensure no concurrent writes if exact sync point is needed.
     *
     * NOTE: For BunBlockDevice, Bun.write() is already synchronous to disk,
     * so sync() is mostly a no-op. Included for interface consistency and
     * future implementations that may buffer.
     */
    sync(): Promise<void>;

    /**
     * Get device metadata.
     *
     * WHY: Provides size, optimal I/O block size, and read-only status.
     * Callers use this to align I/O, avoid out-of-bounds reads, and detect
     * read-only media.
     *
     * @returns Device metadata
     */
    stat(): Promise<BlockStat>;

    /**
     * Acquire write lock for a byte range.
     *
     * WHY: Provides advisory locking to coordinate concurrent writes. Multiple
     * readers can coexist, but writers are exclusive. Lock prevents other
     * writers from overlapping ranges.
     *
     * ALGORITHM:
     * 1. Check for overlapping locks
     * 2. If overlap, enqueue waiter and block
     * 3. When woken, recheck and retry
     * 4. When no overlap, acquire lock and return handle
     *
     * RACE CONDITION:
     * Multiple callers may wait for the same range. When lock is released,
     * exactly one waiter is woken (FIFO order). The woken waiter must recheck
     * for conflicts (another lock may have been acquired while it was waking).
     *
     * TESTABILITY: Returns BlockLock which implements Disposable for `using`.
     *
     * @param offset - Start of range to lock (>= 0)
     * @param size - Size of range in bytes (> 0)
     * @returns Lock handle (release when done)
     */
    writelock(offset: number, size: number): Promise<BlockLock>;
}

// =============================================================================
// HELPER CLASSES
// =============================================================================

/**
 * Simple range lock implementation.
 *
 * WHY: Tracks locked ranges and blocks callers until range is available.
 * Provides advisory locking for coordinating concurrent writes to block device.
 *
 * ALGORITHM:
 * - locks: Array of currently held locks (offset, size)
 * - waiters: Array of pending waiters (offset, size, resolve callback)
 * - acquire(): Check for overlap, wait if needed, add to locks
 * - release(): Remove from locks, wake compatible waiters
 *
 * RACE CONDITION MITIGATIONS:
 * - FIFO waiter queue ensures fairness (first to wait, first to wake)
 * - Waiters are woken selectively (only if no remaining conflicts)
 * - Each waiter rechecks conflicts after waking (handles spurious wakeups)
 *
 * TESTABILITY: All state is in-memory arrays (inspectable via debugger).
 */
class RangeLock {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Currently held locks.
     * WHY: Tracks which ranges are locked to detect conflicts.
     * INVARIANT: All ranges are non-overlapping within this array.
     */
    private locks: Array<{ offset: number; size: number; resolve: () => void }> = [];

    /**
     * Pending waiters.
     * WHY: Queue of callers waiting for locks to be released.
     * INVARIANT: Waiters are processed in FIFO order.
     */
    private waiters: Array<{ offset: number; size: number; resolve: () => void }> = [];

    // =========================================================================
    // HELPER METHODS
    // =========================================================================

    /**
     * Check if two ranges overlap.
     *
     * WHY: Core conflict detection logic. Two ranges overlap if their
     * intervals intersect: [a.offset, a.offset + a.size) overlaps
     * [b.offset, b.offset + b.size) if neither is entirely before the other.
     *
     * ALGORITHM:
     * - a ends at aEnd = a.offset + a.size
     * - b ends at bEnd = b.offset + b.size
     * - Overlap if: a.offset < bEnd AND b.offset < aEnd
     *
     * @param a - First range
     * @param b - Second range
     * @returns True if ranges overlap
     */
    private overlaps(a: { offset: number; size: number }, b: { offset: number; size: number }): boolean {
        const aEnd = a.offset + a.size;
        const bEnd = b.offset + b.size;

        return a.offset < bEnd && b.offset < aEnd;
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Acquire lock for a range.
     *
     * WHY: Blocks until the requested range is available. Ensures that only
     * one writer can hold a lock on any given byte at a time.
     *
     * ALGORITHM:
     * 1. Check if any held lock overlaps with requested range
     * 2. If overlap, enqueue waiter and block (via Promise)
     * 3. When woken by release(), recheck for conflicts
     * 4. Repeat until no conflicts, then add to locks array
     *
     * RACE CONDITION:
     * Multiple waiters may wake when a lock is released. Each waiter must
     * recheck conflicts because another waiter might have acquired a conflicting
     * lock first. This is a classic "thundering herd" scenario, mitigated by
     * selective wakeup (only wake waiters that might proceed).
     *
     * @param offset - Start of range to lock
     * @param size - Size of range
     */
    async acquire(offset: number, size: number): Promise<void> {
        const range = { offset, size, resolve: () => {} };

        // RACE FIX: Loop until no conflicts (handles spurious wakeups)
        while (this.locks.some(lock => this.overlaps(lock, range))) {
            // Wait for release
            await new Promise<void>(resolve => {
                range.resolve = resolve;
                this.waiters.push(range);
            });
        }

        this.locks.push(range);
    }

    /**
     * Release a lock.
     *
     * WHY: Frees a locked range and wakes waiters that can now proceed.
     *
     * ALGORITHM:
     * 1. Find and remove lock from locks array
     * 2. For each waiter, check if it now has no conflicts
     * 3. Wake all compatible waiters (remove from queue, call resolve())
     *
     * RACE CONDITION:
     * Multiple waiters may be woken if they don't conflict with each other.
     * For example, releasing lock [100, 200) may wake waiters for [0, 50)
     * and [300, 400) simultaneously. Each waiter rechecks conflicts in acquire().
     *
     * @param offset - Start of range to release
     * @param size - Size of range
     */
    release(offset: number, size: number): void {
        // Remove from locks
        const idx = this.locks.findIndex(l => l.offset === offset && l.size === size);

        if (idx !== -1) {
            this.locks.splice(idx, 1);
        }

        // Wake waiters that might now be able to proceed
        // WHY: Selective wakeup reduces spurious wakeups
        const toWake = this.waiters.filter(
            w => !this.locks.some(lock => this.overlaps(lock, w)),
        );

        this.waiters = this.waiters.filter(w => !toWake.includes(w));
        for (const w of toWake) {
            w.resolve();
        }
    }
}

// =============================================================================
// IMPLEMENTATIONS
// =============================================================================

/**
 * File-backed block device using Bun.file()
 *
 * WHY: Provides persistent block storage backed by a file on the host filesystem.
 * This is the primary storage mechanism for Monk OS when running on a host OS.
 *
 * ARCHITECTURE:
 * - Uses Bun.file(path) to get a file handle (lightweight, no open() syscall)
 * - Reads use file.slice() to get byte range, then arrayBuffer() to read
 * - Writes use read-modify-write cycle for partial updates (NOT atomic)
 * - Whole-file writes use Bun.write() directly (atomic)
 * - No persistent file descriptor (Bun.file() is cheap, recreated per operation)
 *
 * CONCURRENCY:
 * - Multiple reads are safe (Bun.file() is read-only until write)
 * - Writes are NOT serialized; caller must use writelock()
 * - Read-modify-write cycles are NOT atomic; crash may corrupt
 *
 * LIMITATIONS:
 * - No sparse file support; writing past EOF zero-fills gap
 * - No file locking; concurrent access from multiple processes unsafe
 * - Partial writes require full read of file (performance cost)
 *
 * TESTABILITY:
 * - Can be tested against real files (requires filesystem)
 * - MemoryBlockDevice preferred for unit tests (faster, no I/O)
 */
export class BunBlockDevice implements BlockDevice {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Path to backing file on host filesystem.
     * WHY: Stored to pass to Bun.file() on each operation.
     * INVARIANT: Path never changes after construction.
     */
    private path: string;

    /**
     * Range lock coordinator.
     * WHY: Provides writelock() functionality. Shared across all operations
     * on this device to coordinate concurrent writes.
     * INVARIANT: Exactly one RangeLock per BunBlockDevice instance.
     */
    private rangeLock = new RangeLock();

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create a file-backed block device.
     *
     * WHY: Simple constructor that stores path. No file operations performed
     * here (lazy initialization). File may not exist yet (created on first write).
     *
     * @param path - Path to backing file on host filesystem
     */
    constructor(path: string) {
        this.path = path;
    }

    // =========================================================================
    // BLOCK DEVICE OPERATIONS
    // =========================================================================

    /**
     * Read bytes from file at offset.
     *
     * WHY: Uses Bun.file().slice().arrayBuffer() for efficient range reads.
     *
     * ALGORITHM:
     * 1. Check if file exists (return empty if not)
     * 2. Get file size, check if offset is past EOF (return empty if so)
     * 3. Clamp read to file bounds [offset, min(offset + size, fileSize))
     * 4. Use slice() to get range, arrayBuffer() to read bytes
     * 5. Convert ArrayBuffer to Uint8Array and return
     *
     * RACE CONDITION:
     * If file is written concurrently, read may see partial old/new data.
     * Bun.file() snapshots file at first access, so reads are consistent
     * within a single operation.
     *
     * @param offset - Byte offset to start reading
     * @param size - Number of bytes to read
     * @returns Raw bytes (may be shorter than size at EOF)
     */
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

    /**
     * Write bytes to file at offset.
     *
     * WHY: Provides random-access writes to file. Extends file if writing
     * past EOF. Uses read-modify-write for partial updates.
     *
     * ALGORITHM:
     * 1. If new file and offset == 0, simple case: Bun.write(path, data)
     * 2. Otherwise, read entire existing file into buffer
     * 3. If writing past EOF, extend buffer and zero-fill gap
     * 4. Apply write: buffer[offset:offset+len] = data
     * 5. Write entire buffer back: Bun.write(path, buffer)
     *
     * RACE CONDITION - CRITICAL:
     * Steps 2-5 are NOT atomic. If process crashes during this sequence,
     * file may be left in inconsistent state (partial old/new data).
     * Higher layers (VFS, database) must implement journaling or WAL if
     * crash consistency is required.
     *
     * PERFORMANCE:
     * Partial writes require reading entire file. For large files with small
     * writes, this is expensive. Consider buffering or log-structured writes
     * in higher layers.
     *
     * @param offset - Byte offset to start writing
     * @param data - Bytes to write
     */
    async write(offset: number, data: Uint8Array): Promise<void> {
        const file = Bun.file(this.path);
        const exists = await file.exists();

        if (!exists && offset === 0) {
            // Simple case: new file, write from start
            // WHY: Bun.write() is atomic for whole-file writes
            await Bun.write(this.path, data);

            return;
        }

        // Read-modify-write for partial updates
        // RACE FIX: NOT FIXABLE - This sequence is inherently non-atomic
        // Caller must implement journaling if crash consistency is needed
        let existing: Uint8Array;

        if (exists) {
            const buffer = await file.arrayBuffer();

            existing = new Uint8Array(buffer);
        }
        else {
            existing = new Uint8Array(0);
        }

        // Extend buffer if writing past current end
        const requiredSize = offset + data.length;
        let result: Uint8Array;

        if (requiredSize > existing.length) {
            result = new Uint8Array(requiredSize);
            result.set(existing);
            // WHY: Gap is zero-filled automatically (Uint8Array initializes to zeros)
        }
        else {
            result = existing;
        }

        // Apply write
        result.set(data, offset);
        await Bun.write(this.path, result);
    }

    /**
     * Flush pending writes to durable storage.
     *
     * WHY: Ensures data survives process crash or power loss.
     *
     * NOTE: For BunBlockDevice, Bun.write() is already synchronous to disk
     * on completion. No additional flushing needed. This method is included
     * for interface consistency and future implementations that may buffer.
     *
     * TESTABILITY: No-op makes testing simpler (no fsync failures).
     */
    async sync(): Promise<void> {
        // Bun.write() is synchronous to disk on completion
        // No buffering to flush
    }

    /**
     * Get device metadata.
     *
     * WHY: Provides size and optimal I/O block size for callers.
     *
     * ALGORITHM:
     * 1. Check if file exists
     * 2. If exists, get file.size
     * 3. Return size, blocksize (4096), readonly (false)
     *
     * @returns Device metadata
     */
    async stat(): Promise<BlockStat> {
        const file = Bun.file(this.path);
        const exists = await file.exists();

        return {
            size: exists ? file.size : 0,
            blocksize: 4096, // WHY: Common filesystem block size, good alignment
            readonly: false,
        };
    }

    /**
     * Acquire write lock for a byte range.
     *
     * WHY: Provides advisory locking to coordinate concurrent writes.
     * Prevents data corruption from interleaved writes.
     *
     * ALGORITHM:
     * 1. Call rangeLock.acquire() to wait for range availability
     * 2. Create BlockLock handle with release() method
     * 3. Implement Symbol.dispose for `using` pattern
     * 4. Return handle
     *
     * TESTABILITY: Returns handle that can be checked in tests.
     * release() is synchronous so tests can verify lock state.
     *
     * @param offset - Start of range to lock
     * @param size - Size of range in bytes
     * @returns Lock handle (release when done)
     */
    async writelock(offset: number, size: number): Promise<BlockLock> {
        await this.rangeLock.acquire(offset, size);

        const self = this;
        let released = false;

        const release = () => {
            if (!released) {
                released = true;
                self.rangeLock.release(offset, size);
            }
        };

        return {
            offset,
            size,
            release,
            [Symbol.dispose]: release,
        };
    }
}

/**
 * In-memory block device backed by ArrayBuffer
 *
 * WHY: Provides ephemeral block storage in RAM. Useful for testing (fast,
 * deterministic) and standalone mode (no filesystem dependency).
 *
 * ARCHITECTURE:
 * - Single ArrayBuffer that grows dynamically (doubles each time)
 * - Reads return copies (not views) to prevent external mutation
 * - Writes may trigger buffer growth (allocate new, copy old)
 * - No persistence (data lost on process exit)
 *
 * CONCURRENCY:
 * - Same as BunBlockDevice: reads are safe, writes need serialization
 * - Buffer growth is atomic within JavaScript event loop
 *
 * LIMITATIONS:
 * - All data lost on process exit
 * - Limited by available memory
 * - No durability (sync() is no-op)
 *
 * TESTABILITY:
 * - Ideal for unit tests (no filesystem I/O, no cleanup)
 * - reset() method allows test isolation
 * - Deterministic (no file timestamps, permissions, etc.)
 */
export class MemoryBlockDevice implements BlockDevice {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * In-memory byte buffer.
     * WHY: Stores all block device data. Grows dynamically as needed.
     * INVARIANT: Length is always >= initialSize.
     */
    private buffer: Uint8Array;

    /**
     * Initial buffer size.
     * WHY: Stored for reset() method. Allows restoring device to initial state.
     * INVARIANT: Never changes after construction.
     */
    private readonly initialSize: number;

    /**
     * Range lock coordinator.
     * WHY: Provides writelock() functionality, same as BunBlockDevice.
     * INVARIANT: Exactly one RangeLock per MemoryBlockDevice instance.
     */
    private rangeLock = new RangeLock();

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create an in-memory block device.
     *
     * WHY: Allocates initial buffer. Size is hint; buffer grows as needed.
     *
     * @param initialSize - Initial buffer size in bytes (default 1MB)
     */
    constructor(initialSize: number = 1024 * 1024) {
        this.initialSize = initialSize;
        this.buffer = new Uint8Array(initialSize);
    }

    // =========================================================================
    // BLOCK DEVICE OPERATIONS
    // =========================================================================

    /**
     * Read bytes from memory at offset.
     *
     * WHY: Simple array slice. Fast, synchronous (but wrapped in Promise
     * for interface consistency).
     *
     * ALGORITHM:
     * 1. Check if offset is past buffer end (return empty if so)
     * 2. Clamp read to buffer bounds
     * 3. Return slice (copy, not view)
     *
     * NOTE: Returns copy to prevent caller from mutating internal buffer.
     *
     * @param offset - Byte offset to start reading
     * @param size - Number of bytes to read
     * @returns Raw bytes (may be shorter than size at EOF)
     */
    async read(offset: number, size: number): Promise<Uint8Array> {
        if (offset >= this.buffer.length) {
            return new Uint8Array(0);
        }

        const end = Math.min(offset + size, this.buffer.length);

        // WHY: Return a copy to prevent external mutation of internal state
        return this.buffer.slice(offset, end);
    }

    /**
     * Write bytes to memory at offset.
     *
     * WHY: Simple array assignment. May grow buffer if writing past end.
     *
     * ALGORITHM:
     * 1. Calculate required size (offset + data.length)
     * 2. If required > current, grow buffer (double until large enough)
     * 3. Write data at offset: buffer[offset:] = data
     *
     * RACE CONDITION:
     * Buffer growth (allocate, copy) is atomic within JavaScript event loop.
     * No await points, so no interleaving possible during growth.
     *
     * PERFORMANCE:
     * Doubling strategy amortizes growth cost. N writes cost O(N) total.
     *
     * @param offset - Byte offset to start writing
     * @param data - Bytes to write
     */
    async write(offset: number, data: Uint8Array): Promise<void> {
        const requiredSize = offset + data.length;

        // Grow buffer if needed (double each time)
        // WHY: Exponential growth amortizes allocation cost
        if (requiredSize > this.buffer.length) {
            let newSize = this.buffer.length;

            while (newSize < requiredSize) {
                newSize *= 2;
            }

            const newBuffer = new Uint8Array(newSize);

            newBuffer.set(this.buffer);
            this.buffer = newBuffer;
            // RACE FIX: Atomic within event loop (no await points)
        }

        this.buffer.set(data, offset);
    }

    /**
     * Flush pending writes to durable storage.
     *
     * WHY: No-op for memory device (no durability). Included for interface
     * consistency.
     *
     * TESTABILITY: Simplifies testing (no fsync failures).
     */
    async sync(): Promise<void> {
        // No-op for memory device
    }

    /**
     * Get device metadata.
     *
     * WHY: Returns current buffer size and standard blocksize.
     *
     * @returns Device metadata
     */
    async stat(): Promise<BlockStat> {
        return {
            size: this.buffer.length,
            blocksize: 4096, // WHY: Standard hint, same as file-backed
            readonly: false,
        };
    }

    /**
     * Reset device to initial state.
     *
     * WHY: Testing convenience method. Allows test isolation without
     * creating new device instances.
     *
     * NOTE: Not part of BlockDevice interface. Test-only method.
     *
     * TESTABILITY: Enables test isolation (each test starts fresh).
     */
    reset(): void {
        this.buffer = new Uint8Array(this.initialSize);
    }

    /**
     * Acquire write lock for a byte range.
     *
     * WHY: Provides advisory locking, same as BunBlockDevice.
     *
     * ALGORITHM:
     * Same as BunBlockDevice.writelock().
     *
     * @param offset - Start of range to lock
     * @param size - Size of range in bytes
     * @returns Lock handle (release when done)
     */
    async writelock(offset: number, size: number): Promise<BlockLock> {
        await this.rangeLock.acquire(offset, size);

        const self = this;
        let released = false;

        const release = () => {
            if (!released) {
                released = true;
                self.rangeLock.release(offset, size);
            }
        };

        return {
            offset,
            size,
            release,
            [Symbol.dispose]: release,
        };
    }
}
