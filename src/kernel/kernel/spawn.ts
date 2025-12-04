/**
 * Spawn a child process.
 *
 * ALGORITHM:
 * 1. Create process object
 * 2. Setup stdio (inherit from parent or create pipes)
 * 3. Create and start worker
 * 4. Register in process table
 * 5. Assign PID in parent's namespace
 *
 * @module kernel/kernel/spawn
 */

import type { Kernel } from '../kernel.js';
import type { Process, SpawnOpts } from '../types.js';
import { createProcess } from './create-process.js';
import { setupStdio } from './setup-stdio.js';
import { spawnWorker } from './spawn-worker.js';
import { printk } from './printk.js';

/**
 * Spawn a child process.
 *
 * @param self - Kernel instance
 * @param parent - Parent process
 * @param entry - Entry point path
 * @param opts - Spawn options
 * @returns PID in parent's namespace
 */
export async function spawn(
    self: Kernel,
    parent: Process,
    entry: string,
    opts?: SpawnOpts
): Promise<number> {
    const proc = createProcess(self, {
        parent,
        cmd: entry,
        cwd: opts?.cwd,
        env: opts?.env,
        args: opts?.args,
    });

    // Setup stdio (inherit from parent by default)
    setupStdio(self, proc, parent, opts);

    // Create and start worker
    proc.worker = await spawnWorker(self, proc, entry);
    proc.state = 'running';

    // Register in process table
    // WHY AFTER WORKER: Process should be queryable only when actually running
    self.processes.register(proc);

    // Assign PID in parent's namespace
    // WHY ATOMIC: No await between incrementing and setting
    const pid = parent.nextPid++;
    parent.children.set(pid, proc.id);

    printk(self, 'spawn', `${entry} started as PID ${pid} (UUID: ${proc.id.slice(0, 8)})`);

    return pid;
}
