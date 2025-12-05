/**
 * IPC Device - Inter-process communication primitives
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The IPC Device provides low-level synchronization and communication primitives
 * for coordinating concurrent processes in Monk OS. Despite JavaScript being
 * single-threaded, Bun Workers enable true parallelism, requiring synchronization
 * mechanisms.
 *
 * This layer provides four abstractions:
 *
 * 1. SharedArrayBuffer: Raw shared memory accessible from multiple workers
 * 2. MessagePort: Async message passing between workers (structured clone)
 * 3. Mutex: Mutual exclusion locks (one holder at a time)
 * 4. Semaphore: Counting synchronization (N holders at a time)
 * 5. CondVar: Condition variables (wait/signal pattern)
 *
 * These primitives are built on JavaScript standard APIs:
 * - SharedArrayBuffer: Standard shared memory primitive
 * - Atomics.wait/notify: Standard blocking wait and wakeup
 * - Atomics.compareExchange: Standard atomic read-modify-write
 * - MessageChannel: Standard message passing API
 *
 * The key design challenge: Atomics.wait() blocks the event loop, which is
 * forbidden on the main thread. Therefore, all blocking operations (lock(),
 * wait(), CondVar.wait()) can only be called from Workers, not the main thread.
 * For main thread, callers must use trylock() and trywait() (non-blocking).
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Mutex state is 0 (unlocked) or 1 (locked)
 * INV-2: Semaphore value is always >= 0
 * INV-3: All offsets are 4-byte aligned (required for Int32Array)
 * INV-4: SharedArrayBuffer contents persist until all references released
 * INV-5: Mutex unlock() wakes exactly one waiter
 * INV-6: Semaphore post() wakes exactly one waiter
 * INV-7: CondVar broadcast() wakes all waiters
 * INV-8: CondVar wait() releases mutex before blocking, reacquires before returning
 * INV-9: Lock/wait operations may only be called from Workers (not main thread)
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded per worker, but multiple workers can run in
 * parallel. SharedArrayBuffer enables shared state across workers.
 *
 * Synchronization semantics:
 * - Atomics.wait() blocks the calling worker (not the entire process)
 * - Atomics.notify() wakes blocked workers (up to N waiters)
 * - Atomics.compareExchange() provides atomic read-modify-write
 * - MessagePort provides async message passing (no shared state)
 *
 * Critical constraints:
 * - Atomics.wait() throws "not allowed" error on main thread
 * - Lock acquisition must use spin-wait on main thread (trylock() in loop)
 * - MessagePort transfer is one-time (port can't be transferred again)
 *
 * Race conditions to consider:
 * - Multiple waiters waking simultaneously (thundering herd)
 * - Lock released while multiple waiters spinning (CAS contention)
 * - CondVar spurious wakeups (waiter must recheck predicate)
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Mutex uses compareExchange for atomic lock acquisition
 * RC-2: Mutex lock() spins briefly before blocking (reduces contention)
 * RC-3: Semaphore uses CAS loop for atomic decrement (handles contention)
 * RC-4: CondVar increments sequence number to prevent lost wakeups
 * RC-5: All lock release operations wake exactly one waiter (not broadcast)
 * RC-6: MockIPCDevice provides non-blocking implementations for testing
 *
 * MEMORY MANAGEMENT
 * =================
 * SharedArrayBuffer:
 * - Allocated via new SharedArrayBuffer(size)
 * - Memory shared across workers (not copied)
 * - Released when all references dropped (garbage collected)
 * - Contents persist until deallocation
 *
 * MessagePort:
 * - Created via new MessageChannel() (returns two connected ports)
 * - One port can be transferred to worker via postMessage
 * - Transfer is one-time (port becomes unusable in sender)
 * - Ports are garbage collected when no references remain
 *
 * Mutex/Semaphore/CondVar:
 * - Backed by 4 bytes in SharedArrayBuffer (Int32Array element)
 * - Multiple synchronization primitives can share one SharedArrayBuffer
 * - Offset must be 4-byte aligned (Int32Array requirement)
 * - State persists in SharedArrayBuffer (survives object GC)
 *
 * TESTABILITY
 * ===========
 * - MockIPCDevice provides non-blocking implementations for single-threaded tests
 * - MockMutex throws if lock would block (fails fast in tests)
 * - MockSemaphore throws if wait would block (fails fast in tests)
 * - MockCondVar always times out (no-op signal/broadcast)
 * - Real implementations can be tested with Workers (integration tests)
 * - SharedArrayBuffer state can be inspected via Int32Array view
 *
 * @module hal/ipc
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Mutex lock options.
 *
 * WHY: Provides timeout support to prevent deadlock. If lock can't be acquired
 * within timeout, operation fails rather than blocking forever.
 */
export interface MutexLockOpts {
    /**
     * Lock timeout in milliseconds.
     *
     * WHY: Prevents deadlock by bounding wait time. If exceeded, lock() throws
     * ETIMEDOUT error. Caller can decide whether to retry or fail.
     *
     * @default undefined (wait forever)
     */
    timeout?: number;
}

/**
 * Mutex interface for mutual exclusion.
 *
 * WHY: Provides mutual exclusion lock (only one holder at a time). Used to
 * protect critical sections where multiple workers might conflict.
 *
 * INVARIANTS:
 * - State is 0 (unlocked) or 1 (locked)
 * - unlock() wakes exactly one waiter
 * - lock() may only be called from Workers (not main thread)
 */
export interface Mutex {
    /**
     * Acquire lock.
     *
     * WHY: Blocks until lock is available or timeout exceeded. Ensures that
     * only one worker holds the lock at a time.
     *
     * ALGORITHM:
     * 1. Try to acquire lock via compareExchange(0 -> 1)
     * 2. If successful, return immediately
     * 3. If locked, spin briefly (10 iterations)
     * 4. If still locked, block via Atomics.wait()
     * 5. When woken, retry from step 1
     *
     * RACE CONDITION:
     * Multiple waiters may wake when lock is released. Each waiter uses
     * compareExchange to acquire lock atomically. Only one succeeds; others
     * go back to waiting.
     *
     * WARNING: Blocks the event loop in main thread. Use trylock() instead
     * on main thread, or only call from Workers.
     *
     * @param opts - Lock options (timeout)
     * @throws ETIMEDOUT if timeout exceeded
     * @throws Error if called on main thread
     */
    lock(opts?: MutexLockOpts): void;

    /**
     * Try to acquire lock without blocking.
     *
     * WHY: Non-blocking alternative to lock(). Safe to call from main thread.
     * Useful for opportunistic locking or spin-wait loops.
     *
     * ALGORITHM:
     * 1. Try to acquire lock via compareExchange(0 -> 1)
     * 2. Return true if successful, false if locked
     *
     * @returns true if lock acquired, false if already held
     */
    trylock(): boolean;

    /**
     * Release lock.
     *
     * WHY: Frees the lock and wakes one waiting worker. Must be called by
     * the lock holder (no ownership tracking enforced).
     *
     * ALGORITHM:
     * 1. Set state to 0 (unlocked) via Atomics.store()
     * 2. Wake one waiter via Atomics.notify(count=1)
     *
     * RACE CONDITION:
     * Exactly one waiter is woken. If multiple waiters are blocked, they
     * wake one at a time as lock is repeatedly acquired and released.
     */
    unlock(): void;

    /**
     * Check if lock is currently held.
     *
     * WHY: Allows debugging and assertions. Not safe for synchronization
     * (value may change immediately after reading).
     */
    readonly locked: boolean;
}

/**
 * Semaphore interface for counting synchronization.
 *
 * WHY: Provides counting lock (N holders at a time). Used to limit concurrent
 * access to resources (e.g., connection pool, worker pool).
 *
 * INVARIANTS:
 * - Value is always >= 0
 * - wait() decrements value (blocks if zero)
 * - post() increments value (wakes one waiter)
 */
export interface Semaphore {
    /**
     * Decrement semaphore.
     *
     * WHY: Acquires one unit of the resource. Blocks if count is zero (all
     * units held by others).
     *
     * ALGORITHM:
     * 1. Load current value
     * 2. If value > 0, try to decrement via compareExchange
     * 3. If CAS succeeds, return
     * 4. If value == 0, block via Atomics.wait()
     * 5. When woken, retry from step 1
     *
     * RACE CONDITION:
     * Multiple waiters may compete to decrement when count becomes non-zero.
     * compareExchange ensures only one succeeds per post().
     *
     * WARNING: Blocks the event loop. Use trywait() on main thread.
     *
     * @throws Error if called on main thread
     */
    wait(): void;

    /**
     * Try to decrement without blocking.
     *
     * WHY: Non-blocking alternative to wait(). Safe to call from main thread.
     *
     * ALGORITHM:
     * 1. Load current value
     * 2. If value > 0, try to decrement via compareExchange
     * 3. If CAS succeeds, return true
     * 4. If value == 0, return false
     *
     * @returns true if decremented, false if count was zero
     */
    trywait(): boolean;

    /**
     * Increment semaphore.
     *
     * WHY: Releases one unit of the resource. Wakes one waiting worker.
     *
     * ALGORITHM:
     * 1. Increment value via Atomics.add(+1)
     * 2. Wake one waiter via Atomics.notify(count=1)
     *
     * RACE CONDITION:
     * Exactly one waiter is woken. Woken waiter competes with other waiters
     * via compareExchange in wait().
     */
    post(): void;

    /**
     * Current semaphore value.
     *
     * WHY: Allows debugging and monitoring. Not safe for synchronization
     * (value may change immediately after reading).
     */
    value(): number;
}

/**
 * Condition variable interface.
 *
 * WHY: Provides wait/signal synchronization pattern. Worker waits until some
 * condition is true, signaled by another worker. Used for producer-consumer,
 * work queues, event notification.
 *
 * INVARIANTS:
 * - wait() must hold mutex when called
 * - wait() releases mutex before blocking, reacquires before returning
 * - signal() wakes one waiter
 * - broadcast() wakes all waiters
 */
export interface CondVar {
    /**
     * Wait for signal.
     *
     * WHY: Blocks until another worker calls signal() or broadcast(). Caller
     * must hold the associated mutex. Mutex is released while waiting,
     * reacquired before returning.
     *
     * ALGORITHM:
     * 1. Load sequence number
     * 2. Release mutex
     * 3. Block via Atomics.wait(expectedSeq)
     * 4. When woken, reacquire mutex
     * 5. Return
     *
     * RACE CONDITION:
     * Spurious wakeups are possible (Atomics.wait() may wake without notify).
     * Caller must recheck condition in a loop:
     * ```typescript
     * mutex.lock();
     * while (!condition) {
     *     condvar.wait(mutex);
     * }
     * // Condition is now true, mutex is held
     * mutex.unlock();
     * ```
     *
     * WARNING: Blocks the event loop. Only call from Workers.
     *
     * @param mutex - Mutex to release while waiting (must be held by caller)
     * @throws Error if called on main thread
     */
    wait(mutex: Mutex): void;

    /**
     * Wait with timeout.
     *
     * WHY: Bounded wait to prevent indefinite blocking. Useful when condition
     * might never become true.
     *
     * ALGORITHM:
     * Same as wait(), but Atomics.wait() is called with timeout.
     *
     * @param mutex - Mutex to release while waiting
     * @param ms - Maximum milliseconds to wait
     * @returns false if timed out, true if signaled
     * @throws Error if called on main thread
     */
    timedwait(mutex: Mutex, ms: number): boolean;

    /**
     * Wake one waiting worker.
     *
     * WHY: Signals that condition may now be true. Wakes one waiter to recheck.
     *
     * ALGORITHM:
     * 1. Increment sequence number via Atomics.add(+1)
     * 2. Wake one waiter via Atomics.notify(count=1)
     *
     * RACE CONDITION:
     * Exactly one waiter is woken. Woken waiter reacquires mutex and rechecks
     * condition.
     */
    signal(): void;

    /**
     * Wake all waiting workers.
     *
     * WHY: Signals that condition may now be true for all waiters. All waiters
     * wake and recheck condition.
     *
     * ALGORITHM:
     * 1. Increment sequence number via Atomics.add(+1)
     * 2. Wake all waiters via Atomics.notify() (no count limit)
     *
     * RACE CONDITION:
     * All waiters wake simultaneously and compete to reacquire mutex. They
     * serialize through mutex acquisition.
     */
    broadcast(): void;
}

/**
 * IPC device interface.
 *
 * WHY: Provides factory methods for creating IPC primitives. Abstracts the
 * underlying implementation (real vs. mock).
 */
export interface IPCDevice {
    /**
     * Allocate shared memory buffer.
     *
     * WHY: Creates SharedArrayBuffer that can be transferred to workers.
     * Used as backing store for mutexes, semaphores, condition variables,
     * and custom shared data structures.
     *
     * ALGORITHM:
     * 1. Allocate SharedArrayBuffer with specified size
     * 2. Return buffer (initialized to zeros)
     *
     * TESTABILITY: Buffer can be inspected via Int32Array or Uint8Array view.
     *
     * @param size - Buffer size in bytes
     * @returns Shared buffer (initialized to zeros)
     */
    alloc(size: number): SharedArrayBuffer;

    /**
     * Create a message port pair.
     *
     * WHY: Provides async message passing between workers. One end can be
     * transferred to a worker, enabling bidirectional communication.
     *
     * ALGORITHM:
     * 1. Create MessageChannel
     * 2. Return both ports (port1 and port2)
     *
     * NOTE: One port should be transferred to worker via postMessage. After
     * transfer, the port is no longer usable in the sender.
     *
     * @returns Connected port pair (a and b)
     */
    port(): { a: MessagePort; b: MessagePort };

    /**
     * Create a mutex backed by shared memory.
     *
     * WHY: Provides mutual exclusion lock. Multiple workers can access the
     * same mutex by sharing the backing buffer.
     *
     * ALGORITHM:
     * 1. Create Int32Array view of buffer at offset
     * 2. Initialize state to 0 (unlocked)
     * 3. Return Mutex handle
     *
     * @param buf - Shared buffer (must be at least offset + 4 bytes)
     * @param offset - Byte offset for mutex state (must be 4-byte aligned)
     * @returns Mutex handle
     * @throws Error if offset is not 4-byte aligned
     */
    mutex(buf: SharedArrayBuffer, offset: number): Mutex;

    /**
     * Create a semaphore backed by shared memory.
     *
     * WHY: Provides counting synchronization. Multiple workers can access the
     * same semaphore by sharing the backing buffer.
     *
     * ALGORITHM:
     * 1. Create Int32Array view of buffer at offset
     * 2. Initialize state to n (initial value)
     * 3. Return Semaphore handle
     *
     * @param buf - Shared buffer (must be at least offset + 4 bytes)
     * @param offset - Byte offset for semaphore state (must be 4-byte aligned)
     * @param n - Initial semaphore value (>= 0)
     * @returns Semaphore handle
     * @throws Error if offset is not 4-byte aligned
     * @throws Error if n is negative
     */
    semaphore(buf: SharedArrayBuffer, offset: number, n: number): Semaphore;

    /**
     * Create a condition variable backed by shared memory.
     *
     * WHY: Provides wait/signal synchronization. Multiple workers can access
     * the same condvar by sharing the backing buffer.
     *
     * ALGORITHM:
     * 1. Create Int32Array view of buffer at offset
     * 2. Initialize sequence number to 0
     * 3. Return CondVar handle
     *
     * @param buf - Shared buffer (must be at least offset + 4 bytes)
     * @param offset - Byte offset for condvar state (must be 4-byte aligned)
     * @returns Condition variable handle
     * @throws Error if offset is not 4-byte aligned
     */
    condvar(buf: SharedArrayBuffer, offset: number): CondVar;
}

// =============================================================================
// IMPLEMENTATION - BUN IPC DEVICE
// =============================================================================

/**
 * Bun IPC device implementation.
 *
 * WHY: Implements IPCDevice using standard JavaScript APIs (SharedArrayBuffer,
 * MessageChannel, Atomics). Works in Bun and any JavaScript environment with
 * SharedArrayBuffer support.
 *
 * ARCHITECTURE:
 * - alloc() creates SharedArrayBuffer
 * - port() creates MessageChannel
 * - mutex/semaphore/condvar create handles backed by SharedArrayBuffer
 * - All synchronization uses Atomics primitives (wait/notify/compareExchange)
 *
 * CONCURRENCY:
 * All operations are thread-safe (backed by atomic operations). Multiple
 * workers can call factory methods concurrently.
 *
 * LIMITATIONS:
 * - Atomics.wait() throws in main thread (use MockIPCDevice for testing)
 * - SharedArrayBuffer requires cross-origin isolation in browsers (not in Bun)
 * - All offsets must be 4-byte aligned (Int32Array requirement)
 *
 * TESTABILITY:
 * - Can be tested with Workers (integration tests)
 * - Use MockIPCDevice for unit tests (single-threaded)
 */
export class BunIPCDevice implements IPCDevice {
    /**
     * Allocate shared memory buffer.
     *
     * WHY: Simple wrapper around new SharedArrayBuffer(). Included for
     * interface consistency.
     *
     * @param size - Buffer size in bytes
     * @returns Shared buffer
     */
    alloc(size: number): SharedArrayBuffer {
        return new SharedArrayBuffer(size);
    }

    /**
     * Create a message port pair.
     *
     * WHY: Simple wrapper around new MessageChannel(). Included for
     * interface consistency.
     *
     * @returns Connected port pair
     */
    port(): { a: MessagePort; b: MessagePort } {
        const channel = new MessageChannel();

        return { a: channel.port1, b: channel.port2 };
    }

    /**
     * Create a mutex backed by shared memory.
     *
     * WHY: Factory method for creating Mutex. All mutexes backed by the same
     * buffer+offset share the same state (multiple handles, single lock).
     *
     * @param buf - Shared buffer
     * @param offset - Byte offset (must be 4-byte aligned)
     * @returns Mutex handle
     */
    mutex(buf: SharedArrayBuffer, offset: number): Mutex {
        return new AtomicMutex(buf, offset);
    }

    /**
     * Create a semaphore backed by shared memory.
     *
     * WHY: Factory method for creating Semaphore. All semaphores backed by
     * the same buffer+offset share the same state.
     *
     * @param buf - Shared buffer
     * @param offset - Byte offset (must be 4-byte aligned)
     * @param n - Initial value (>= 0)
     * @returns Semaphore handle
     */
    semaphore(buf: SharedArrayBuffer, offset: number, n: number): Semaphore {
        return new AtomicSemaphore(buf, offset, n);
    }

    /**
     * Create a condition variable backed by shared memory.
     *
     * WHY: Factory method for creating CondVar. All condvars backed by the
     * same buffer+offset share the same state.
     *
     * @param buf - Shared buffer
     * @param offset - Byte offset (must be 4-byte aligned)
     * @returns Condition variable handle
     */
    condvar(buf: SharedArrayBuffer, offset: number): CondVar {
        return new AtomicCondVar(buf, offset);
    }
}

// =============================================================================
// HELPER CLASSES - ATOMIC IMPLEMENTATIONS
// =============================================================================

/**
 * Mutex implementation using Atomics.
 *
 * WHY: Provides mutual exclusion via atomic compareExchange. State is stored
 * in SharedArrayBuffer at specified offset.
 *
 * ARCHITECTURE:
 * - State: 0 = unlocked, 1 = locked
 * - lock(): Spin briefly, then block via Atomics.wait()
 * - unlock(): Set to 0, wake one waiter via Atomics.notify()
 * - trylock(): Atomic compareExchange(0 -> 1)
 *
 * RACE CONDITIONS:
 * - Multiple lockers compete via compareExchange (only one succeeds)
 * - unlock() wakes exactly one waiter (others remain blocked)
 * - Spurious wakeups handled by retry loop in lock()
 */
class AtomicMutex implements Mutex {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Int32Array view of backing buffer.
     * WHY: Atomics operations require Int32Array (not Uint8Array).
     */
    private view: Int32Array;

    /**
     * Array index for mutex state.
     * WHY: Atomics operations use array index (not byte offset).
     */
    private index: number;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create a mutex backed by shared memory.
     *
     * WHY: Validates alignment, creates Int32Array view, initializes state.
     *
     * ALGORITHM:
     * 1. Check offset is 4-byte aligned (required for Int32Array)
     * 2. Create Int32Array view of buffer
     * 3. Calculate array index (offset / 4)
     * 4. Initialize state to 0 (unlocked)
     *
     * @param buf - Shared buffer
     * @param offset - Byte offset (must be 4-byte aligned)
     * @throws Error if offset is not 4-byte aligned
     */
    constructor(buf: SharedArrayBuffer, offset: number) {
        if (offset % 4 !== 0) {
            throw new Error('Mutex offset must be 4-byte aligned');
        }

        this.view = new Int32Array(buf);
        this.index = offset / 4;

        // Initialize to unlocked
        // WHY: Ensures mutex starts in known state
        Atomics.store(this.view, this.index, 0);
    }

    // =========================================================================
    // MUTEX OPERATIONS
    // =========================================================================

    /**
     * Acquire lock.
     *
     * WHY: Blocks until lock is available. Uses spin-wait followed by blocking
     * wait for efficiency.
     *
     * ALGORITHM:
     * 1. Try to acquire lock via compareExchange(0 -> 1)
     * 2. If successful, return immediately
     * 3. If locked, spin for 10 iterations (reduces context switches)
     * 4. If still locked, block via Atomics.wait()
     * 5. When woken, retry from step 1
     *
     * RACE CONDITION:
     * Multiple waiters may wake when lock is released. They compete via
     * compareExchange. Only one succeeds; others go back to waiting.
     *
     * RACE FIX: Spin-wait before blocking reduces contention (brief locks
     * don't require kernel wakeup).
     *
     * @param opts - Lock options (timeout)
     * @throws ETIMEDOUT if timeout exceeded
     * @throws Error if called on main thread (Atomics.wait not allowed)
     */
    lock(opts?: MutexLockOpts): void {
        const startTime = opts?.timeout ? Date.now() : 0;

        // Spin-wait with exponential backoff, then block
        let spins = 0;

        while (true) {
            // Try to acquire
            if (Atomics.compareExchange(this.view, this.index, 0, 1) === 0) {
                return; // Got the lock
            }

            // Check timeout
            if (opts?.timeout) {
                const elapsed = Date.now() - startTime;

                if (elapsed >= opts.timeout) {
                    throw new Error('ETIMEDOUT: Lock timeout');
                }
            }

            // Spin briefly before blocking
            // WHY: Reduces context switches for brief lock holds
            if (spins < 10) {
                spins++;
                continue;
            }

            // Block until notified (with timeout if specified)
            // RACE FIX: Check state after await - lock may have been released
            try {
                const waitTimeout = opts?.timeout
                    ? Math.max(1, opts.timeout - (Date.now() - startTime))
                    : undefined;
                const result = Atomics.wait(this.view, this.index, 1, waitTimeout);

                if (result === 'timed-out') {
                    throw new Error('ETIMEDOUT: Lock timeout');
                }
            }
            catch (e) {
                if (e instanceof Error && e.message.startsWith('ETIMEDOUT')) {
                    throw e;
                }

                // Atomics.wait() throws in main thread
                throw new Error(
                    'Mutex.lock() cannot block on main thread. ' +
                    'Use trylock() or call from a Worker.',
                );
            }

            spins = 0;
        }
    }

    /**
     * Try to acquire lock without blocking.
     *
     * WHY: Non-blocking alternative to lock(). Safe to call from main thread.
     *
     * ALGORITHM:
     * 1. Try to acquire lock via compareExchange(0 -> 1)
     * 2. Return true if successful, false if locked
     *
     * @returns true if lock acquired, false if already held
     */
    trylock(): boolean {
        return Atomics.compareExchange(this.view, this.index, 0, 1) === 0;
    }

    /**
     * Release lock.
     *
     * WHY: Frees the lock and wakes one waiting worker.
     *
     * ALGORITHM:
     * 1. Set state to 0 (unlocked) via Atomics.store()
     * 2. Wake one waiter via Atomics.notify(count=1)
     *
     * RACE CONDITION:
     * Exactly one waiter is woken. If multiple waiters are blocked, they
     * wake one at a time as lock is repeatedly released.
     */
    unlock(): void {
        Atomics.store(this.view, this.index, 0);
        Atomics.notify(this.view, this.index, 1);
    }

    /**
     * Check if lock is currently held.
     *
     * WHY: Allows debugging and assertions. Not safe for synchronization
     * (value may change immediately after reading).
     *
     * @returns true if locked, false if unlocked
     */
    get locked(): boolean {
        return Atomics.load(this.view, this.index) === 1;
    }
}

/**
 * Semaphore implementation using Atomics.
 *
 * WHY: Provides counting synchronization via atomic operations. State is
 * stored in SharedArrayBuffer at specified offset.
 *
 * ARCHITECTURE:
 * - State: current count (>= 0)
 * - wait(): Decrement via CAS loop, block if zero
 * - post(): Increment via Atomics.add(), wake one waiter
 * - trywait(): Decrement via CAS loop, don't block
 *
 * RACE CONDITIONS:
 * - Multiple waiters compete to decrement via CAS (only N succeed for count N)
 * - post() wakes exactly one waiter (others remain blocked)
 * - CAS failures cause retry (handles contention)
 */
class AtomicSemaphore implements Semaphore {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Int32Array view of backing buffer.
     * WHY: Atomics operations require Int32Array.
     */
    private view: Int32Array;

    /**
     * Array index for semaphore state.
     * WHY: Atomics operations use array index.
     */
    private index: number;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create a semaphore backed by shared memory.
     *
     * WHY: Validates alignment and initial value, creates Int32Array view,
     * initializes state.
     *
     * ALGORITHM:
     * 1. Check offset is 4-byte aligned
     * 2. Check initial value is non-negative
     * 3. Create Int32Array view of buffer
     * 4. Calculate array index (offset / 4)
     * 5. Initialize state to initial value
     *
     * @param buf - Shared buffer
     * @param offset - Byte offset (must be 4-byte aligned)
     * @param initial - Initial value (>= 0)
     * @throws Error if offset is not 4-byte aligned
     * @throws Error if initial value is negative
     */
    constructor(buf: SharedArrayBuffer, offset: number, initial: number) {
        if (offset % 4 !== 0) {
            throw new Error('Semaphore offset must be 4-byte aligned');
        }

        if (initial < 0) {
            throw new Error('Semaphore initial value must be non-negative');
        }

        this.view = new Int32Array(buf);
        this.index = offset / 4;
        Atomics.store(this.view, this.index, initial);
    }

    // =========================================================================
    // SEMAPHORE OPERATIONS
    // =========================================================================

    /**
     * Decrement semaphore.
     *
     * WHY: Acquires one unit of the resource. Blocks if count is zero.
     *
     * ALGORITHM:
     * 1. Load current value
     * 2. If value > 0, try to decrement via compareExchange
     * 3. If CAS succeeds, return
     * 4. If CAS fails, retry (another worker changed value)
     * 5. If value == 0, block via Atomics.wait()
     * 6. When woken, retry from step 1
     *
     * RACE CONDITION:
     * Multiple waiters compete to decrement when count becomes non-zero.
     * compareExchange ensures only one succeeds per unit.
     *
     * RACE FIX: CAS loop handles contention (failed CAS retries).
     *
     * @throws Error if called on main thread
     */
    wait(): void {
        while (true) {
            const current = Atomics.load(this.view, this.index);

            if (current > 0) {
                // Try to decrement
                if (Atomics.compareExchange(this.view, this.index, current, current - 1) === current) {
                    return; // Successfully decremented
                }

                // CAS failed, retry
                // WHY: Another worker changed value (post or wait)
                continue;
            }

            // Count is zero, wait for post
            try {
                Atomics.wait(this.view, this.index, 0);
            }
            catch (_e) {
                throw new Error(
                    'Semaphore.wait() cannot block on main thread. ' +
                    'Use trywait() or call from a Worker.',
                );
            }
        }
    }

    /**
     * Try to decrement without blocking.
     *
     * WHY: Non-blocking alternative to wait(). Safe to call from main thread.
     *
     * ALGORITHM:
     * 1. Load current value
     * 2. If value > 0, try to decrement via compareExchange
     * 3. If CAS succeeds, return true
     * 4. If CAS fails, retry (loop until success or value == 0)
     * 5. If value == 0, return false
     *
     * RACE CONDITION:
     * Multiple callers compete via CAS. Only N succeed for count N.
     *
     * @returns true if decremented, false if count was zero
     */
    trywait(): boolean {
        while (true) {
            const current = Atomics.load(this.view, this.index);

            if (current <= 0) {
                return false;
            }

            if (Atomics.compareExchange(this.view, this.index, current, current - 1) === current) {
                return true;
            }
            // CAS failed, retry
        }
    }

    /**
     * Increment semaphore.
     *
     * WHY: Releases one unit of the resource. Wakes one waiting worker.
     *
     * ALGORITHM:
     * 1. Increment value via Atomics.add(+1)
     * 2. Wake one waiter via Atomics.notify(count=1)
     *
     * RACE CONDITION:
     * Exactly one waiter is woken. Woken waiter competes with other waiters
     * via CAS in wait().
     */
    post(): void {
        Atomics.add(this.view, this.index, 1);
        Atomics.notify(this.view, this.index, 1);
    }

    /**
     * Current semaphore value.
     *
     * WHY: Allows debugging and monitoring. Not safe for synchronization
     * (value may change immediately after reading).
     *
     * @returns Current count (>= 0)
     */
    value(): number {
        return Atomics.load(this.view, this.index);
    }
}

/**
 * Condition variable implementation using Atomics.
 *
 * WHY: Provides wait/signal synchronization via sequence number increment.
 * State is stored in SharedArrayBuffer at specified offset.
 *
 * ARCHITECTURE:
 * - State: sequence number (incremented on signal/broadcast)
 * - wait(): Load seq, release mutex, block until seq changes, reacquire mutex
 * - signal(): Increment seq, wake one waiter
 * - broadcast(): Increment seq, wake all waiters
 *
 * RACE CONDITIONS:
 * - Spurious wakeups possible (caller must recheck condition)
 * - Multiple waiters may wake simultaneously (broadcast)
 * - Mutex serializes access to protected data
 */
class AtomicCondVar implements CondVar {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Int32Array view of backing buffer.
     * WHY: Atomics operations require Int32Array.
     */
    private view: Int32Array;

    /**
     * Array index for condvar state.
     * WHY: Atomics operations use array index.
     */
    private index: number;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create a condition variable backed by shared memory.
     *
     * WHY: Validates alignment, creates Int32Array view, initializes state.
     *
     * ALGORITHM:
     * 1. Check offset is 4-byte aligned
     * 2. Create Int32Array view of buffer
     * 3. Calculate array index (offset / 4)
     * 4. Initialize sequence number to 0
     *
     * @param buf - Shared buffer
     * @param offset - Byte offset (must be 4-byte aligned)
     * @throws Error if offset is not 4-byte aligned
     */
    constructor(buf: SharedArrayBuffer, offset: number) {
        if (offset % 4 !== 0) {
            throw new Error('CondVar offset must be 4-byte aligned');
        }

        this.view = new Int32Array(buf);
        this.index = offset / 4;
        Atomics.store(this.view, this.index, 0);
    }

    // =========================================================================
    // CONDITION VARIABLE OPERATIONS
    // =========================================================================

    /**
     * Wait for signal.
     *
     * WHY: Blocks until another worker calls signal() or broadcast(). Releases
     * mutex while waiting, reacquires before returning.
     *
     * ALGORITHM:
     * 1. Load current sequence number
     * 2. Release mutex (other workers can now access protected data)
     * 3. Block via Atomics.wait(expectedSeq)
     * 4. When woken (seq changed), reacquire mutex
     * 5. Return (caller rechecks condition)
     *
     * RACE CONDITION:
     * Spurious wakeups are possible (Atomics.wait() may return without notify).
     * Caller must recheck condition in a loop.
     *
     * RACE FIX: Sequence number prevents lost wakeups (signal before wait
     * will not block).
     *
     * @param mutex - Mutex to release while waiting (must be held by caller)
     * @throws Error if called on main thread
     */
    wait(mutex: Mutex): void {
        const seq = Atomics.load(this.view, this.index);

        mutex.unlock();
        try {
            try {
                Atomics.wait(this.view, this.index, seq);
            }
            catch (_e) {
                throw new Error(
                    'CondVar.wait() cannot block on main thread. ' +
                    'Call from a Worker.',
                );
            }
        }
        finally {
            // RACE FIX: Always reacquire mutex, even if wait throws
            mutex.lock();
        }
    }

    /**
     * Wait with timeout.
     *
     * WHY: Bounded wait to prevent indefinite blocking. Useful when condition
     * might never become true.
     *
     * ALGORITHM:
     * Same as wait(), but Atomics.wait() is called with timeout.
     *
     * @param mutex - Mutex to release while waiting
     * @param ms - Maximum milliseconds to wait
     * @returns false if timed out, true if signaled
     * @throws Error if called on main thread
     */
    timedwait(mutex: Mutex, ms: number): boolean {
        const seq = Atomics.load(this.view, this.index);

        mutex.unlock();
        try {
            let result: 'ok' | 'not-equal' | 'timed-out';

            try {
                result = Atomics.wait(this.view, this.index, seq, ms);
            }
            catch (_e) {
                throw new Error(
                    'CondVar.timedwait() cannot block on main thread. ' +
                    'Call from a Worker.',
                );
            }

            return result !== 'timed-out';
        }
        finally {
            // RACE FIX: Always reacquire mutex, even if wait throws
            mutex.lock();
        }
    }

    /**
     * Wake one waiting worker.
     *
     * WHY: Signals that condition may now be true. Wakes one waiter to recheck.
     *
     * ALGORITHM:
     * 1. Increment sequence number via Atomics.add(+1)
     * 2. Wake one waiter via Atomics.notify(count=1)
     *
     * RACE CONDITION:
     * Exactly one waiter is woken. Woken waiter reacquires mutex and rechecks
     * condition. Other waiters remain blocked.
     */
    signal(): void {
        Atomics.add(this.view, this.index, 1);
        Atomics.notify(this.view, this.index, 1);
    }

    /**
     * Wake all waiting workers.
     *
     * WHY: Signals that condition may now be true for all waiters. All waiters
     * wake and recheck condition.
     *
     * ALGORITHM:
     * 1. Increment sequence number via Atomics.add(+1)
     * 2. Wake all waiters via Atomics.notify() (no count limit)
     *
     * RACE CONDITION:
     * All waiters wake simultaneously and compete to reacquire mutex. They
     * serialize through mutex acquisition. Each waiter rechecks condition.
     */
    broadcast(): void {
        Atomics.add(this.view, this.index, 1);
        Atomics.notify(this.view, this.index);
    }
}

// =============================================================================
// MOCK IMPLEMENTATIONS (FOR TESTING)
// =============================================================================

/**
 * Mock IPC device for testing.
 *
 * WHY: Provides non-blocking implementations for single-threaded testing.
 * Fails fast if lock would block (helps catch synchronization bugs in tests).
 *
 * ARCHITECTURE:
 * - alloc() and port() are real (standard APIs work in single-threaded)
 * - Mutex/Semaphore/CondVar are mocks (throw if they would block)
 *
 * TESTABILITY:
 * - Tests can verify locking logic without Workers
 * - MockMutex/Semaphore throw if lock would block (fails fast)
 * - MockCondVar always times out (no-op signal/broadcast)
 *
 * USAGE:
 * ```typescript
 * const ipc = new MockIPCDevice();
 * const buf = ipc.alloc(64);
 * const mutex = ipc.mutex(buf, 0);
 * mutex.lock();  // OK (not held)
 * mutex.lock();  // Throws (would block)
 * ```
 */
export class MockIPCDevice implements IPCDevice {
    /**
     * Allocate shared memory buffer.
     *
     * WHY: Real implementation (SharedArrayBuffer works in single-threaded).
     */
    alloc(size: number): SharedArrayBuffer {
        return new SharedArrayBuffer(size);
    }

    /**
     * Create a message port pair.
     *
     * WHY: Real implementation (MessageChannel works in single-threaded).
     */
    port(): { a: MessagePort; b: MessagePort } {
        const channel = new MessageChannel();

        return { a: channel.port1, b: channel.port2 };
    }

    /**
     * Create a mock mutex.
     *
     * WHY: Returns MockMutex which throws if lock would block.
     */
    mutex(_buf: SharedArrayBuffer, _offset: number): Mutex {
        return new MockMutex();
    }

    /**
     * Create a mock semaphore.
     *
     * WHY: Returns MockSemaphore which throws if wait would block.
     */
    semaphore(_buf: SharedArrayBuffer, _offset: number, n: number): Semaphore {
        return new MockSemaphore(n);
    }

    /**
     * Create a mock condition variable.
     *
     * WHY: Returns MockCondVar which throws if wait would block.
     */
    condvar(_buf: SharedArrayBuffer, _offset: number): CondVar {
        return new MockCondVar();
    }
}

/**
 * Mock mutex that doesn't block.
 *
 * WHY: For testing. Throws if lock would block (helps catch bugs).
 */
class MockMutex implements Mutex {
    private _locked = false;

    lock(_opts?: MutexLockOpts): void {
        if (this._locked) {
            throw new Error('MockMutex: would block (already locked)');
        }

        this._locked = true;
    }

    trylock(): boolean {
        if (this._locked) {
            return false;
        }

        this._locked = true;

        return true;
    }

    unlock(): void {
        this._locked = false;
    }

    get locked(): boolean {
        return this._locked;
    }
}

/**
 * Mock semaphore that doesn't block.
 *
 * WHY: For testing. Throws if wait would block (helps catch bugs).
 */
class MockSemaphore implements Semaphore {
    private count: number;

    constructor(initial: number) {
        this.count = initial;
    }

    wait(): void {
        if (this.count <= 0) {
            throw new Error('MockSemaphore: would block (count is zero)');
        }

        this.count--;
    }

    trywait(): boolean {
        if (this.count <= 0) {
            return false;
        }

        this.count--;

        return true;
    }

    post(): void {
        this.count++;
    }

    value(): number {
        return this.count;
    }
}

/**
 * Mock condvar that doesn't block.
 *
 * WHY: For testing. Always times out (no-op signal/broadcast).
 */
class MockCondVar implements CondVar {
    wait(_mutex: Mutex): void {
        throw new Error('MockCondVar: would block');
    }

    timedwait(_mutex: Mutex, _ms: number): boolean {
        return false; // Always timeout
    }

    signal(): void {
        // No-op
    }

    broadcast(): void {
        // No-op
    }
}
