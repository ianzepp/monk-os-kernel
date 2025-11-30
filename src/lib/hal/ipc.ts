/**
 * IPC Device
 *
 * Inter-process communication primitives: shared memory, message ports, synchronization.
 *
 * Bun touchpoints:
 * - SharedArrayBuffer for shared memory between workers
 * - MessageChannel / MessagePort for message passing
 * - Atomics for synchronization primitives
 *
 * Caveats:
 * - SharedArrayBuffer requires cross-origin isolation in browsers (not Bun)
 * - Atomics.wait() blocks the thread; use only in workers, not main thread
 * - MessagePort must be transferred to workers via postMessage
 * - Mutex/semaphore implementations use Atomics.wait/notify
 * - Deadlock possible if locks acquired in inconsistent order
 */

/**
 * Mutex lock options
 */
export interface MutexLockOpts {
    /** Lock timeout in milliseconds. If exceeded, throws ETIMEDOUT. */
    timeout?: number;
}

/**
 * Mutex interface for mutual exclusion
 */
export interface Mutex {
    /**
     * Acquire lock.
     * Blocks until lock is available or timeout.
     *
     * Bun: Atomics.wait() + Atomics.compareExchange()
     *
     * WARNING: Blocks the event loop in main thread.
     * Only use in Workers.
     *
     * @param opts - Lock options (timeout)
     * @throws ETIMEDOUT if timeout exceeded
     */
    lock(opts?: MutexLockOpts): void;

    /**
     * Try to acquire lock without blocking.
     *
     * @returns true if lock acquired, false if already held
     */
    trylock(): boolean;

    /**
     * Release lock.
     *
     * Bun: Atomics.store() + Atomics.notify()
     */
    unlock(): void;

    /**
     * Check if lock is currently held.
     */
    readonly locked: boolean;
}

/**
 * Semaphore interface for counting synchronization
 */
export interface Semaphore {
    /**
     * Decrement semaphore.
     * Blocks if count is zero.
     *
     * Bun: Atomics.wait() loop
     */
    wait(): void;

    /**
     * Try to decrement without blocking.
     *
     * @returns true if decremented, false if count was zero
     */
    trywait(): boolean;

    /**
     * Increment semaphore.
     * Wakes one waiting thread.
     *
     * Bun: Atomics.add() + Atomics.notify()
     */
    post(): void;

    /**
     * Current semaphore value.
     */
    value(): number;
}

/**
 * Condition variable interface
 */
export interface CondVar {
    /**
     * Wait for signal.
     * Must hold the associated mutex when calling.
     * Mutex is released while waiting, reacquired before returning.
     *
     * @param mutex - Mutex to release while waiting
     */
    wait(mutex: Mutex): void;

    /**
     * Wait with timeout.
     *
     * @param mutex - Mutex to release while waiting
     * @param ms - Maximum milliseconds to wait
     * @returns false if timed out, true if signaled
     */
    timedwait(mutex: Mutex, ms: number): boolean;

    /**
     * Wake one waiting thread.
     */
    signal(): void;

    /**
     * Wake all waiting threads.
     */
    broadcast(): void;
}

/**
 * IPC device interface.
 */
export interface IPCDevice {
    /**
     * Allocate shared memory buffer.
     *
     * Bun: new SharedArrayBuffer(size)
     *
     * Can be transferred to workers via postMessage for shared state.
     *
     * @param size - Buffer size in bytes
     * @returns Shared buffer
     */
    alloc(size: number): SharedArrayBuffer;

    /**
     * Create a message port pair.
     *
     * Bun: new MessageChannel()
     *
     * One end can be transferred to a worker via postMessage.
     * Ports provide async message passing between threads.
     *
     * @returns Connected port pair
     */
    port(): { a: MessagePort; b: MessagePort };

    /**
     * Create a mutex backed by shared memory.
     *
     * @param buf - Shared buffer (must be at least offset + 4 bytes)
     * @param offset - Byte offset for mutex state (must be 4-byte aligned)
     * @returns Mutex handle
     */
    mutex(buf: SharedArrayBuffer, offset: number): Mutex;

    /**
     * Create a semaphore backed by shared memory.
     *
     * @param buf - Shared buffer (must be at least offset + 4 bytes)
     * @param offset - Byte offset for semaphore state (must be 4-byte aligned)
     * @param n - Initial semaphore value
     * @returns Semaphore handle
     */
    semaphore(buf: SharedArrayBuffer, offset: number, n: number): Semaphore;

    /**
     * Create a condition variable backed by shared memory.
     *
     * @param buf - Shared buffer (must be at least offset + 4 bytes)
     * @param offset - Byte offset for condvar state (must be 4-byte aligned)
     * @returns Condition variable handle
     */
    condvar(buf: SharedArrayBuffer, offset: number): CondVar;
}

/**
 * Bun IPC device implementation
 *
 * Bun touchpoints:
 * - SharedArrayBuffer (standard)
 * - MessageChannel (standard)
 * - Atomics.wait/notify/compareExchange (standard)
 *
 * Caveats:
 * - Atomics.wait() throws in main thread with "not allowed" error
 * - All offsets must be 4-byte aligned for Int32Array
 * - SharedArrayBuffer contents persist until all references released
 */
export class BunIPCDevice implements IPCDevice {
    alloc(size: number): SharedArrayBuffer {
        return new SharedArrayBuffer(size);
    }

    port(): { a: MessagePort; b: MessagePort } {
        const channel = new MessageChannel();
        return { a: channel.port1, b: channel.port2 };
    }

    mutex(buf: SharedArrayBuffer, offset: number): Mutex {
        return new AtomicMutex(buf, offset);
    }

    semaphore(buf: SharedArrayBuffer, offset: number, n: number): Semaphore {
        return new AtomicSemaphore(buf, offset, n);
    }

    condvar(buf: SharedArrayBuffer, offset: number): CondVar {
        return new AtomicCondVar(buf, offset);
    }
}

/**
 * Mutex implementation using Atomics
 *
 * State: 0 = unlocked, 1 = locked
 */
class AtomicMutex implements Mutex {
    private view: Int32Array;
    private index: number;

    constructor(buf: SharedArrayBuffer, offset: number) {
        if (offset % 4 !== 0) {
            throw new Error('Mutex offset must be 4-byte aligned');
        }
        this.view = new Int32Array(buf);
        this.index = offset / 4;
        // Initialize to unlocked
        Atomics.store(this.view, this.index, 0);
    }

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
            if (spins < 10) {
                spins++;
                continue;
            }

            // Block until notified (with timeout if specified)
            try {
                const waitTimeout = opts?.timeout
                    ? Math.max(1, opts.timeout - (Date.now() - startTime))
                    : undefined;
                const result = Atomics.wait(this.view, this.index, 1, waitTimeout);
                if (result === 'timed-out') {
                    throw new Error('ETIMEDOUT: Lock timeout');
                }
            } catch (e) {
                if (e instanceof Error && e.message.startsWith('ETIMEDOUT')) {
                    throw e;
                }
                // Atomics.wait() throws in main thread
                throw new Error(
                    'Mutex.lock() cannot block on main thread. ' +
                    'Use trylock() or call from a Worker.'
                );
            }
            spins = 0;
        }
    }

    trylock(): boolean {
        return Atomics.compareExchange(this.view, this.index, 0, 1) === 0;
    }

    unlock(): void {
        Atomics.store(this.view, this.index, 0);
        Atomics.notify(this.view, this.index, 1);
    }

    get locked(): boolean {
        return Atomics.load(this.view, this.index) === 1;
    }
}

/**
 * Semaphore implementation using Atomics
 *
 * State: current count (>= 0)
 */
class AtomicSemaphore implements Semaphore {
    private view: Int32Array;
    private index: number;

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

    wait(): void {
        while (true) {
            const current = Atomics.load(this.view, this.index);
            if (current > 0) {
                // Try to decrement
                if (Atomics.compareExchange(this.view, this.index, current, current - 1) === current) {
                    return; // Successfully decremented
                }
                // CAS failed, retry
                continue;
            }

            // Count is zero, wait for post
            try {
                Atomics.wait(this.view, this.index, 0);
            } catch (e) {
                throw new Error(
                    'Semaphore.wait() cannot block on main thread. ' +
                    'Use trywait() or call from a Worker.'
                );
            }
        }
    }

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

    post(): void {
        Atomics.add(this.view, this.index, 1);
        Atomics.notify(this.view, this.index, 1);
    }

    value(): number {
        return Atomics.load(this.view, this.index);
    }
}

/**
 * Condition variable implementation using Atomics
 *
 * State: wait sequence number (incremented on signal)
 */
class AtomicCondVar implements CondVar {
    private view: Int32Array;
    private index: number;

    constructor(buf: SharedArrayBuffer, offset: number) {
        if (offset % 4 !== 0) {
            throw new Error('CondVar offset must be 4-byte aligned');
        }
        this.view = new Int32Array(buf);
        this.index = offset / 4;
        Atomics.store(this.view, this.index, 0);
    }

    wait(mutex: Mutex): void {
        const seq = Atomics.load(this.view, this.index);
        mutex.unlock();
        try {
            try {
                Atomics.wait(this.view, this.index, seq);
            } catch (e) {
                throw new Error(
                    'CondVar.wait() cannot block on main thread. ' +
                    'Call from a Worker.'
                );
            }
        } finally {
            mutex.lock();
        }
    }

    timedwait(mutex: Mutex, ms: number): boolean {
        const seq = Atomics.load(this.view, this.index);
        mutex.unlock();
        try {
            let result: 'ok' | 'not-equal' | 'timed-out';
            try {
                result = Atomics.wait(this.view, this.index, seq, ms);
            } catch (e) {
                throw new Error(
                    'CondVar.timedwait() cannot block on main thread. ' +
                    'Call from a Worker.'
                );
            }
            return result !== 'timed-out';
        } finally {
            mutex.lock();
        }
    }

    signal(): void {
        Atomics.add(this.view, this.index, 1);
        Atomics.notify(this.view, this.index, 1);
    }

    broadcast(): void {
        Atomics.add(this.view, this.index, 1);
        Atomics.notify(this.view, this.index);
    }
}

/**
 * Mock IPC device for testing
 *
 * Provides non-blocking implementations for single-threaded testing.
 *
 * Usage:
 *   const ipc = new MockIPCDevice();
 *   const buf = ipc.alloc(64);
 *   const mutex = ipc.mutex(buf, 0);
 *   mutex.lock();  // Doesn't block in mock
 *   mutex.unlock();
 */
export class MockIPCDevice implements IPCDevice {
    alloc(size: number): SharedArrayBuffer {
        return new SharedArrayBuffer(size);
    }

    port(): { a: MessagePort; b: MessagePort } {
        const channel = new MessageChannel();
        return { a: channel.port1, b: channel.port2 };
    }

    mutex(buf: SharedArrayBuffer, offset: number): Mutex {
        return new MockMutex();
    }

    semaphore(buf: SharedArrayBuffer, offset: number, n: number): Semaphore {
        return new MockSemaphore(n);
    }

    condvar(buf: SharedArrayBuffer, offset: number): CondVar {
        return new MockCondVar();
    }
}

/**
 * Mock mutex that doesn't block
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
        if (this._locked) return false;
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
 * Mock semaphore that doesn't block
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
        if (this.count <= 0) return false;
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
 * Mock condvar that doesn't block
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
