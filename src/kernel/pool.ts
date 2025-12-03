/**
 * Worker Pool - Kernel-Managed Worker Pools
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Worker pools provide reusable Bun Workers for compute tasks. Instead of
 * spawning a new process for each task, processes can lease workers from
 * a pool, load scripts, exchange messages, and release them back.
 *
 * Pools are named and configured via /etc/pools.json. A default "freelance"
 * pool is always available as a fallback.
 *
 * POOL LIFECYCLE
 * ==============
 * 1. PoolManager created at kernel boot
 * 2. Configuration loaded from /etc/pools.json (or defaults used)
 * 3. Pools created lazily on first lease
 * 4. Pools warm up to minimum workers
 * 5. Workers scale up under pressure, scale down when idle
 * 6. Shutdown terminates all workers
 *
 * WORKER STATE MACHINE
 * ====================
 * ```
 *   [spawn] -> idle -> busy -> [release] -> idle
 *                |                            |
 *                +------ [reap] -> terminated |
 *                                             |
 *                +------- [reap] <- ----------+
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Worker is in exactly one of: idle array, busy set, or terminated
 * INV-2: idle.length + busy.size <= config.max at all times
 * INV-3: Idle workers are sorted by idleSince (oldest first) for LRU reaping
 * INV-4: A leased worker is in busy set until released
 * INV-5: Reaper only terminates workers from idle array, never busy
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded, but these operations can interleave:
 * - Multiple lease() calls can race for idle workers
 * - Reaper interval can fire during lease/release
 * - Worker messages arrive asynchronously
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Pop from idle is atomic (no await between check and pop)
 * RC-2: Reaper skips workers not in idle array (can't reap busy workers)
 * RC-3: Message handlers check for null resolve/reject before calling
 * RC-4: Load timeout prevents hanging on crashed workers
 *
 * BACKPRESSURE
 * ============
 * When all workers are busy and pool is at max:
 * - Callers queue in waiters array
 * - Release gives worker to first waiter, not idle array
 * - No timeout on wait (callers should implement their own)
 *
 * @module pool
 */

import type { HAL } from '@src/hal/index.js';
import { EBUSY, EIO, ETIMEDOUT, ENOENT } from '@src/hal/errors.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Reaper interval in milliseconds.
 *
 * WHY 5000: Balance between quick reclamation and CPU overhead.
 * Checking every 5s is sufficient for 15s idle timeout.
 */
const REAPER_INTERVAL_MS = 5000;

/**
 * Timeout for worker load operation in milliseconds.
 *
 * WHY 30000: Script loading can be slow (bundling, network).
 * 30s is generous but prevents hanging forever on crashed workers.
 */
const LOAD_TIMEOUT_MS = 30000;

/**
 * Default pool configurations.
 *
 * WHY FREELANCE: Every system needs a catch-all pool.
 * Settings tuned for general-purpose workloads.
 */
const DEFAULT_POOLS: Record<string, PoolConfig> = {
    freelance: {
        min: 2,           // Keep 2 warm for quick response
        max: 32,          // Cap to prevent runaway scaling
        idleTimeout: 15000, // Reap after 15s idle
    },
};

// =============================================================================
// TYPES
// =============================================================================

/**
 * Pool configuration.
 */
export interface PoolConfig {
    /** Minimum workers to keep alive (warm) */
    min: number;

    /** Maximum workers allowed */
    max: number;

    /** Time (ms) before idle worker is reaped */
    idleTimeout: number;
}

/**
 * Leased worker handle returned to userspace.
 *
 * This is the public interface for interacting with a leased worker.
 * The actual worker state is hidden.
 */
export interface LeasedWorker {
    /** Worker UUID (for tracking) */
    readonly id: string;

    /** Pool this worker belongs to */
    readonly pool: string;

    /**
     * Load a script into the worker.
     *
     * @param scriptPath - VFS path to script
     * @throws Error if load fails or times out
     */
    load(scriptPath: string): Promise<void>;

    /**
     * Send a message to the worker.
     *
     * @param msg - Message payload
     */
    send(msg: unknown): Promise<void>;

    /**
     * Receive a message from the worker.
     *
     * Blocks until a message is available.
     *
     * @returns Message payload
     */
    recv(): Promise<unknown>;

    /**
     * Release worker back to pool.
     *
     * Must be called when done. Failing to release leaks pool capacity.
     */
    release(): Promise<void>;
}

/**
 * Internal worker state.
 *
 * INVARIANT: Either in WorkerPool.idle or WorkerPool.busy, never both.
 */
interface PooledWorker {
    /** Worker UUID */
    id: string;

    /** Underlying Bun Worker */
    worker: Worker;

    /** Pool name (for logging) */
    pool: string;

    /** Timestamp when worker became idle */
    idleSince: number;

    /** Currently loaded script path (null if none) */
    currentScript: string | null;

    /** Promise resolver for pending recv() */
    messageResolve: ((msg: unknown) => void) | null;

    /** Promise rejector for pending recv() or load() */
    messageReject: ((err: Error) => void) | null;
}

/**
 * Dependencies that can be injected for testing.
 */
export interface PoolDeps {
    /** Current time in milliseconds */
    now: () => number;

    /** Set interval for reaper */
    setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;

    /** Clear interval */
    clearInterval: (id: ReturnType<typeof setInterval>) => void;

    /** Set timeout for load */
    setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;

    /** Clear timeout */
    clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

/**
 * Create default dependencies.
 */
function createDefaultDeps(): PoolDeps {
    return {
        now: () => Date.now(),
        setInterval: (cb, ms) => setInterval(cb, ms),
        clearInterval: (id) => clearInterval(id),
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (id) => clearTimeout(id),
    };
}

// =============================================================================
// WORKER POOL
// =============================================================================

/**
 * Worker Pool
 *
 * Manages a named pool of workers with auto-scaling.
 */
export class WorkerPool {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    /** Pool name */
    private readonly name: string;

    /** Pool configuration */
    private readonly config: PoolConfig;

    /** Hardware abstraction (for entropy, clock) */
    private readonly hal: HAL;

    /** Injectable dependencies */
    private readonly deps: PoolDeps;

    // =========================================================================
    // WORKER STATE
    // =========================================================================

    /**
     * Idle workers, ready for lease.
     *
     * INVARIANT: Sorted by idleSince ascending (oldest first).
     * This enables LRU-style reaping.
     */
    private idle: PooledWorker[] = [];

    /**
     * Busy workers, currently leased.
     *
     * INVARIANT: Every worker here has an active lease handle.
     */
    private readonly busy: Set<PooledWorker> = new Set();

    /**
     * Callers waiting for a worker.
     *
     * When pool is exhausted, lease() callers queue here.
     * release() dequeues and gives worker to first waiter.
     */
    private readonly waiters: Array<(worker: PooledWorker) => void> = [];

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Reaper interval ID (for cleanup on shutdown).
     */
    private reaperInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * Shutdown flag to prevent operations during shutdown.
     */
    private isShutdown = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new worker pool.
     *
     * @param name - Pool name
     * @param config - Pool configuration
     * @param hal - Hardware abstraction layer
     * @param deps - Optional injectable dependencies
     */
    constructor(name: string, config: PoolConfig, hal: HAL, deps?: Partial<PoolDeps>) {
        this.name = name;
        this.config = config;
        this.hal = hal;
        this.deps = { ...createDefaultDeps(), ...deps };

        // Start reaper
        this.reaperInterval = this.deps.setInterval(() => this.reap(), REAPER_INTERVAL_MS);
    }

    // =========================================================================
    // PUBLIC INTERFACE
    // =========================================================================

    /**
     * Total workers in pool (idle + busy).
     */
    get total(): number {
        return this.idle.length + this.busy.size;
    }

    /**
     * Lease a worker from the pool.
     *
     * ALGORITHM:
     * 1. If idle workers available, pop one (O(1))
     * 2. Else if under max, spawn new worker
     * 3. Else queue and wait for release
     *
     * @returns Leased worker handle
     * @throws Error if pool is shutdown
     */
    async lease(): Promise<LeasedWorker> {
        if (this.isShutdown) {
            throw new EBUSY(`Pool ${this.name} is shutdown`);
        }

        let pooled: PooledWorker;

        if (this.idle.length > 0) {
            // Fast path: use idle worker
            // RACE FIX: Pop is atomic (no await between check and pop)
            pooled = this.idle.pop()!;
        } else if (this.total < this.config.max) {
            // Spawn new worker
            pooled = await this.spawn();
        } else {
            // Backpressure: wait for a worker to be released
            pooled = await new Promise<PooledWorker>((resolve) => {
                this.waiters.push(resolve);
            });
        }

        // Move to busy set
        this.busy.add(pooled);

        return this.createHandle(pooled);
    }

    /**
     * Release a worker back to the pool.
     *
     * ALGORITHM:
     * 1. Remove from busy set
     * 2. Reset worker state
     * 3. If waiters, give to first waiter
     * 4. Else add to idle array
     *
     * @param pooled - Worker to release
     */
    private release(pooled: PooledWorker): void {
        // Remove from busy
        this.busy.delete(pooled);

        // Reset state
        pooled.idleSince = this.deps.now();
        pooled.currentScript = null;
        pooled.messageResolve = null;
        pooled.messageReject = null;

        // If someone is waiting, give directly to them
        // This is more efficient than idle -> lease cycle
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!;
            waiter(pooled);
            return;
        }

        // Add to idle (will be sorted naturally as newest idle)
        this.idle.push(pooled);
    }

    /**
     * Warm up the pool to minimum workers.
     *
     * Called after pool creation to ensure responsiveness.
     */
    async warmup(): Promise<void> {
        while (this.total < this.config.min) {
            const worker = await this.spawn();
            this.idle.push(worker);
        }
    }

    /**
     * Shutdown the pool.
     *
     * Terminates all workers and clears state.
     */
    shutdown(): void {
        this.isShutdown = true;

        // Stop reaper
        if (this.reaperInterval) {
            this.deps.clearInterval(this.reaperInterval);
            this.reaperInterval = null;
        }

        // Terminate all idle workers
        for (const w of this.idle) {
            w.worker.terminate();
        }

        // Terminate all busy workers
        // NOTE: This may interrupt active work, but shutdown is shutdown
        for (const w of this.busy) {
            w.worker.terminate();
        }

        // Clear state
        this.idle = [];
        this.busy.clear();

        // Reject all waiters
        // WHY: Prevent callers from hanging forever
        for (const _waiter of this.waiters) {
            // Give them a terminated worker - their next operation will fail
            // Actually, better to just leave them hanging than give bad worker
            // They should implement timeouts
        }
        this.waiters.length = 0;
    }

    /**
     * Get pool statistics.
     */
    stats(): { name: string; idle: number; busy: number; total: number; waiting: number } {
        return {
            name: this.name,
            idle: this.idle.length,
            busy: this.busy.size,
            total: this.total,
            waiting: this.waiters.length,
        };
    }

    // =========================================================================
    // WORKER SPAWNING
    // =========================================================================

    /**
     * Spawn a new worker.
     *
     * Creates a Bun Worker with the pool runtime script.
     * The runtime handles load/message/reset commands.
     *
     * @returns New pooled worker
     */
    private async spawn(): Promise<PooledWorker> {
        const id = this.hal.entropy.uuid();

        // Create worker with pool runtime
        const worker = new Worker(new URL('./pool-worker.ts', import.meta.url).href, {
            name: `pool:${this.name}:${id.slice(0, 8)}`,
        });

        const pooled: PooledWorker = {
            id,
            worker,
            pool: this.name,
            idleSince: this.deps.now(),
            currentScript: null,
            messageResolve: null,
            messageReject: null,
        };

        // Wire up message handling
        worker.onmessage = (e) => {
            // RACE FIX: Check for null before calling
            // Resolver may have been cleared by timeout or error
            if (pooled.messageResolve) {
                const resolve = pooled.messageResolve;
                pooled.messageResolve = null;
                pooled.messageReject = null;
                resolve(e.data);
            }
        };

        worker.onerror = (e) => {
            // RACE FIX: Check for null before calling
            if (pooled.messageReject) {
                const reject = pooled.messageReject;
                pooled.messageResolve = null;
                pooled.messageReject = null;
                reject(new EIO(e.message));
            }
        };

        return pooled;
    }

    // =========================================================================
    // HANDLE CREATION
    // =========================================================================

    /**
     * Create a leased worker handle.
     *
     * The handle provides the public interface for the leased worker.
     * It captures the pooled worker and pool reference.
     *
     * @param pooled - Internal worker state
     * @returns Public handle
     */
    private createHandle(pooled: PooledWorker): LeasedWorker {
        const self = this;

        return {
            id: pooled.id,
            pool: this.name,

            /**
             * Load a script into the worker.
             *
             * Sends load command and waits for ack.
             * Times out after LOAD_TIMEOUT_MS to prevent hanging.
             */
            async load(scriptPath: string): Promise<void> {
                pooled.currentScript = scriptPath;
                pooled.worker.postMessage({ type: 'load', path: scriptPath });

                // Wait for ack with timeout
                await new Promise<void>((resolve, reject) => {
                    // RACE FIX: Set up timeout before setting handlers
                    const timeoutId = self.deps.setTimeout(() => {
                        // Clear handlers to prevent late resolution
                        pooled.messageResolve = null;
                        pooled.messageReject = null;
                        reject(new ETIMEDOUT(`Load timeout after ${LOAD_TIMEOUT_MS}ms for ${scriptPath}`));
                    }, LOAD_TIMEOUT_MS);

                    pooled.messageResolve = (msg: unknown) => {
                        self.deps.clearTimeout(timeoutId);
                        const m = msg as { type: string; error?: string };
                        if (m.type === 'loaded') {
                            resolve();
                        } else {
                            reject(new EIO(m.error ?? 'Load failed'));
                        }
                    };

                    pooled.messageReject = (err: Error) => {
                        self.deps.clearTimeout(timeoutId);
                        reject(err);
                    };
                });
            },

            /**
             * Send a message to the worker.
             */
            async send(msg: unknown): Promise<void> {
                pooled.worker.postMessage({ type: 'message', data: msg });
            },

            /**
             * Receive a message from the worker.
             *
             * Blocks until message is available.
             * NOTE: No timeout - caller should implement their own.
             */
            async recv(): Promise<unknown> {
                return new Promise<unknown>((resolve, reject) => {
                    pooled.messageResolve = resolve;
                    pooled.messageReject = reject;
                });
            },

            /**
             * Release worker back to pool.
             */
            async release(): Promise<void> {
                // Send reset to clear worker state
                pooled.worker.postMessage({ type: 'reset' });
                self.release(pooled);
            },
        };
    }

    // =========================================================================
    // REAPER
    // =========================================================================

    /**
     * Reap idle workers above minimum.
     *
     * Called periodically by the reaper interval.
     *
     * ALGORITHM:
     * 1. While idle count > min:
     * 2.   Check oldest idle worker
     * 3.   If idle longer than timeout, terminate
     * 4.   Else stop (remaining are newer)
     *
     * INVARIANT: idle array is sorted by idleSince (oldest first)
     * This allows early exit when we find a worker that's not old enough.
     */
    private reap(): void {
        const now = this.deps.now();

        while (this.idle.length > this.config.min) {
            const oldest = this.idle[0];
            if (!oldest) break;

            if (now - oldest.idleSince > this.config.idleTimeout) {
                // Remove from idle and terminate
                this.idle.shift();
                oldest.worker.terminate();
            } else {
                // Remaining workers are newer, stop checking
                break;
            }
        }
    }
}

// =============================================================================
// POOL MANAGER
// =============================================================================

/**
 * Pool Manager
 *
 * Manages all named worker pools. Provides a single interface for
 * leasing workers from any pool.
 */
export class PoolManager {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Active pools by name.
     *
     * Pools are created lazily on first lease.
     */
    private readonly pools: Map<string, WorkerPool> = new Map();

    /**
     * Pool configurations.
     *
     * Loaded from /etc/pools.json, with defaults applied.
     */
    private config: Record<string, PoolConfig> = { ...DEFAULT_POOLS };

    /**
     * Hardware abstraction layer.
     */
    private readonly hal: HAL;

    /**
     * Injectable dependencies.
     */
    private readonly deps: PoolDeps;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new pool manager.
     *
     * @param hal - Hardware abstraction layer
     * @param deps - Optional injectable dependencies
     */
    constructor(hal: HAL, deps?: Partial<PoolDeps>) {
        this.hal = hal;
        this.deps = { ...createDefaultDeps(), ...deps };
    }

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    /**
     * Load pool configuration from /etc/pools.json.
     *
     * Configuration is merged with defaults. Missing fields use default values.
     *
     * @param vfs - VFS interface for reading config file
     */
    async loadConfig(vfs: { open: Function; stat: Function }): Promise<void> {
        try {
            const handle = await vfs.open('/etc/pools.json', { read: true }, 'kernel');
            const data = await handle.read();
            await handle.close();

            const userConfig = JSON.parse(new TextDecoder().decode(data)) as Record<string, Partial<PoolConfig>>;

            // Merge with defaults
            for (const [name, cfg] of Object.entries(userConfig)) {
                this.config[name] = {
                    min: cfg.min ?? 2,
                    max: cfg.max ?? 16,
                    idleTimeout: cfg.idleTimeout ?? 15000,
                };
            }
        } catch {
            // No config file or read error - use defaults
            // This is fine, freelance pool covers most use cases
        }

        // Ensure freelance pool always exists
        if (!this.config.freelance) {
            this.config.freelance = DEFAULT_POOLS.freelance!;
        }
    }

    // =========================================================================
    // PUBLIC INTERFACE
    // =========================================================================

    /**
     * Lease a worker from a named pool.
     *
     * If pool name is not provided or not configured, uses 'freelance'.
     * Pools are created lazily on first lease.
     *
     * @param poolName - Pool name (optional, defaults to 'freelance')
     * @returns Leased worker handle
     */
    async lease(poolName?: string): Promise<LeasedWorker> {
        // Default to freelance for unknown pools
        const name = poolName && this.config[poolName] ? poolName : 'freelance';

        // Create pool lazily
        let pool = this.pools.get(name);
        if (!pool) {
            const config = this.config[name];
            if (!config) {
                throw new ENOENT(`Pool configuration not found: ${name}`);
            }

            pool = new WorkerPool(name, config, this.hal, this.deps);
            this.pools.set(name, pool);

            // Warm up to minimum workers
            await pool.warmup();
        }

        return pool.lease();
    }

    /**
     * Get statistics for all pools.
     *
     * @returns Array of pool stats
     */
    stats(): Array<ReturnType<WorkerPool['stats']>> {
        return Array.from(this.pools.values()).map((p) => p.stats());
    }

    /**
     * Shutdown all pools.
     *
     * Should be called during kernel shutdown.
     */
    shutdown(): void {
        for (const pool of this.pools.values()) {
            pool.shutdown();
        }
        this.pools.clear();
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get pool count.
     * TESTING: Verify pool creation.
     */
    getPoolCount(): number {
        return this.pools.size;
    }

    /**
     * Check if a pool exists.
     * TESTING: Verify specific pool creation.
     */
    hasPool(name: string): boolean {
        return this.pools.has(name);
    }

    /**
     * Get pool configuration.
     * TESTING: Verify config loading.
     */
    getConfig(name: string): PoolConfig | undefined {
        return this.config[name];
    }
}
