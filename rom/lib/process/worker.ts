/**
 * Worker pool operations for VFS scripts.
 */

import { call } from './syscall';
import type { PoolStats } from './types';

/**
 * Pool API for managing worker pools.
 */
export const pool = {
    /**
     * Lease a worker from a named pool.
     * @param name - Pool name (defaults to 'freelance')
     * @returns Worker UUID
     */
    lease(name?: string): Promise<string> {
        return call<string>('pool:lease', name);
    },

    /**
     * Get pool statistics.
     */
    stats(): Promise<PoolStats> {
        return call<PoolStats>('pool:stats');
    },
};

/**
 * Worker API for interacting with leased workers.
 */
export const worker = {
    /**
     * Load a script into a leased worker.
     * @param workerId - Worker UUID from pool.lease()
     * @param path - VFS path to script
     */
    load(workerId: string, path: string): Promise<void> {
        return call<void>('worker:load', { workerId, path });
    },

    /**
     * Send a message to a leased worker.
     * @param workerId - Worker UUID
     * @param msg - Message to send
     */
    send(workerId: string, msg: unknown): Promise<void> {
        return call<void>('worker:send', { workerId, msg });
    },

    /**
     * Receive a message from a leased worker.
     * @param workerId - Worker UUID
     * @returns Message from worker
     */
    recv(workerId: string): Promise<unknown> {
        return call<unknown>('worker:recv', workerId);
    },

    /**
     * Release a leased worker back to the pool.
     * @param workerId - Worker UUID
     */
    release(workerId: string): Promise<void> {
        return call<void>('worker:release', workerId);
    },
};
