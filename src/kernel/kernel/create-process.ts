/**
 * Create a new Process object with common defaults.
 *
 * NOTE: This only creates the object. The worker is NOT started yet.
 * Process starts in 'starting' state.
 *
 * @module kernel/kernel/create-process
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';

/**
 * Create a new Process object.
 *
 * @param self - Kernel instance
 * @param opts - Process creation options
 * @returns New Process object in 'starting' state
 */
export function createProcess(
    self: Kernel,
    opts: {
        parent?: Process;
        cmd: string;
        cwd?: string;
        env?: Record<string, string>;
        args?: string[];
    }
): Process {
    return {
        // Identity
        id: self.hal.entropy.uuid(),
        parent: opts.parent?.id ?? '',

        // Worker (set after creation)
        worker: null as unknown as Worker,
        state: 'starting',

        // Execution context
        cmd: opts.cmd,
        cwd: opts.cwd ?? opts.parent?.cwd ?? '/',
        env: opts.parent ? { ...opts.parent.env, ...opts.env } : (opts.env ?? {}),
        args: opts.args ?? [opts.cmd],

        // Handle management
        handles: new Map(),
        nextHandle: 3, // 0, 1, 2 reserved for stdio

        // Child management
        children: new Map(),
        nextPid: 1,

        // Stream management
        activeStreams: new Map(),
        streamPingHandlers: new Map(),
    };
}
