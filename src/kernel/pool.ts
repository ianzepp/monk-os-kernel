/**
 * Worker Pool
 *
 * Kernel-managed worker pools for efficient process execution.
 * Pools are defined in /etc/pools.json with a 'freelance' fallback
 * for undefined pool names.
 *
 * Features:
 * - Named pools with isolation between workloads
 * - Auto-scaling: grows under pressure, shrinks when idle
 * - Backpressure: waiters queue when pool is exhausted
 */

import type { HAL } from '@src/hal/index.js';

/**
 * Pool configuration
 */
export interface PoolConfig {
    /** Minimum workers to keep alive */
    min: number;
    /** Maximum workers allowed */
    max: number;
    /** Time (ms) before idle worker is reaped */
    idleTimeout: number;
}

/**
 * Default pool configurations
 */
const DEFAULT_POOLS: Record<string, PoolConfig> = {
    freelance: { min: 2, max: 32, idleTimeout: 15000 },
};

/**
 * Leased worker handle returned to userspace
 */
export interface LeasedWorker {
    /** Worker UUID */
    readonly id: string;
    /** Pool this worker belongs to */
    readonly pool: string;
    /** Load a script into the worker */
    load(scriptPath: string): Promise<void>;
    /** Send a message to the worker */
    send(msg: unknown): Promise<void>;
    /** Receive a message from the worker */
    recv(): Promise<unknown>;
    /** Release worker back to pool */
    release(): Promise<void>;
}

/**
 * Internal worker state
 */
interface PooledWorker {
    id: string;
    worker: Worker;
    pool: string;
    idleSince: number;
    currentScript: string | null;
    messageResolve: ((msg: unknown) => void) | null;
    messageReject: ((err: Error) => void) | null;
}

/**
 * Worker Pool implementation
 */
export class WorkerPool {
    private name: string;
    private config: PoolConfig;
    private hal: HAL;

    private idle: PooledWorker[] = [];
    private busy: Set<PooledWorker> = new Set();
    private waiters: ((worker: PooledWorker) => void)[] = [];
    private reaperInterval: ReturnType<typeof setInterval> | null = null;

    constructor(name: string, config: PoolConfig, hal: HAL) {
        this.name = name;
        this.config = config;
        this.hal = hal;

        // Start reaper
        this.reaperInterval = setInterval(() => this.reap(), 5000);
    }

    /**
     * Total workers in pool (idle + busy)
     */
    get total(): number {
        return this.idle.length + this.busy.size;
    }

    /**
     * Lease a worker from the pool
     */
    async lease(): Promise<LeasedWorker> {
        let pooled: PooledWorker;

        if (this.idle.length > 0) {
            // Use idle worker
            pooled = this.idle.pop()!;
        } else if (this.total < this.config.max) {
            // Spawn new worker
            pooled = await this.spawn();
        } else {
            // Wait for one to become available (backpressure)
            pooled = await new Promise<PooledWorker>((resolve) => {
                this.waiters.push(resolve);
            });
        }

        this.busy.add(pooled);
        return this.createHandle(pooled);
    }

    /**
     * Release a worker back to the pool
     */
    release(pooled: PooledWorker): void {
        this.busy.delete(pooled);
        pooled.idleSince = this.hal.clock.now();
        pooled.currentScript = null;
        pooled.messageResolve = null;
        pooled.messageReject = null;

        // If someone is waiting, give directly to them
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!;
            waiter(pooled);
        } else {
            this.idle.push(pooled);
        }
    }

    /**
     * Spawn a new worker
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
            idleSince: this.hal.clock.now(),
            currentScript: null,
            messageResolve: null,
            messageReject: null,
        };

        // Wire up message handling
        worker.onmessage = (e) => {
            if (pooled.messageResolve) {
                pooled.messageResolve(e.data);
                pooled.messageResolve = null;
                pooled.messageReject = null;
            }
        };

        worker.onerror = (e) => {
            if (pooled.messageReject) {
                pooled.messageReject(new Error(e.message));
                pooled.messageResolve = null;
                pooled.messageReject = null;
            }
        };

        return pooled;
    }

    /**
     * Create a leased worker handle
     */
    private createHandle(pooled: PooledWorker): LeasedWorker {
        const self = this;

        return {
            id: pooled.id,
            pool: this.name,

            async load(scriptPath: string): Promise<void> {
                pooled.currentScript = scriptPath;
                pooled.worker.postMessage({ type: 'load', path: scriptPath });

                // Wait for ack
                await new Promise<void>((resolve, reject) => {
                    pooled.messageResolve = (msg: unknown) => {
                        const m = msg as { type: string; error?: string };
                        if (m.type === 'loaded') resolve();
                        else reject(new Error(m.error ?? 'Load failed'));
                    };
                    pooled.messageReject = reject;
                });
            },

            async send(msg: unknown): Promise<void> {
                pooled.worker.postMessage({ type: 'message', data: msg });
            },

            async recv(): Promise<unknown> {
                return new Promise<unknown>((resolve, reject) => {
                    pooled.messageResolve = resolve;
                    pooled.messageReject = reject;
                });
            },

            async release(): Promise<void> {
                // Reset worker state
                pooled.worker.postMessage({ type: 'reset' });
                self.release(pooled);
            },
        };
    }

    /**
     * Reap idle workers above minimum
     */
    private reap(): void {
        const now = this.hal.clock.now();

        while (this.idle.length > this.config.min) {
            const oldest = this.idle[0];
            if (now - oldest.idleSince > this.config.idleTimeout) {
                this.idle.shift();
                oldest.worker.terminate();
            } else {
                break; // Sorted by idle time
            }
        }
    }

    /**
     * Ensure minimum workers are running
     */
    async warmup(): Promise<void> {
        while (this.total < this.config.min) {
            const worker = await this.spawn();
            this.idle.push(worker);
        }
    }

    /**
     * Shutdown all workers
     */
    shutdown(): void {
        if (this.reaperInterval) {
            clearInterval(this.reaperInterval);
            this.reaperInterval = null;
        }

        for (const w of this.idle) {
            w.worker.terminate();
        }
        for (const w of this.busy) {
            w.worker.terminate();
        }

        this.idle = [];
        this.busy.clear();
    }

    /**
     * Get pool stats
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
}

/**
 * Pool Manager
 *
 * Manages all named pools. Reads config from /etc/pools.json.
 */
export class PoolManager {
    private pools: Map<string, WorkerPool> = new Map();
    private config: Record<string, PoolConfig> = { ...DEFAULT_POOLS };
    private hal: HAL;

    constructor(hal: HAL) {
        this.hal = hal;
    }

    /**
     * Load pool configuration from /etc/pools.json
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
            // No config file, use defaults
        }

        // Ensure freelance exists
        if (!this.config.freelance) {
            this.config.freelance = DEFAULT_POOLS.freelance;
        }
    }

    /**
     * Lease a worker from a named pool
     */
    async lease(poolName?: string): Promise<LeasedWorker> {
        const name = poolName && this.config[poolName] ? poolName : 'freelance';

        let pool = this.pools.get(name);
        if (!pool) {
            pool = new WorkerPool(name, this.config[name], this.hal);
            this.pools.set(name, pool);
            await pool.warmup();
        }

        return pool.lease();
    }

    /**
     * Get all pool stats
     */
    stats(): Array<ReturnType<WorkerPool['stats']>> {
        return Array.from(this.pools.values()).map((p) => p.stats());
    }

    /**
     * Shutdown all pools
     */
    shutdown(): void {
        for (const pool of this.pools.values()) {
            pool.shutdown();
        }
        this.pools.clear();
    }
}
