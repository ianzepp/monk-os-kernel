/**
 * Virtual Process Creation - Create isolated process context without Worker
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Virtual processes enable a process (like gatewayd) to create isolated process
 * contexts for external clients without spawning new Worker threads. The virtual
 * process shares its creator's Worker but has isolated state:
 * - File descriptor table (handles)
 * - Current working directory (cwd)
 * - Environment variables (env)
 * - Process identity (separate UUID/PID)
 *
 * This enables gatewayd to proxy syscalls for multiple external clients, with
 * each client getting isolated state while sharing the gatewayd Worker for
 * communication.
 *
 * STATE MACHINE
 * =============
 * Virtual processes are created in 'running' state immediately (no Worker startup):
 *   [proc:create] --> running --> zombie --> [reaped]
 *
 * INVARIANTS
 * ==========
 * INV-1: Virtual process has virtual=true
 * INV-2: Virtual process shares parent's Worker (worker === parent.worker)
 * INV-3: Virtual process is registered before returning
 * INV-4: Virtual process has unique PID in parent's namespace
 *
 * CONCURRENCY MODEL
 * =================
 * This function is mostly synchronous. createProcess() is sync, registration
 * is sync, PID assignment is sync. No race conditions during creation.
 *
 * However, the virtual process shares the parent's Worker. Multiple virtual
 * processes can make concurrent syscalls through the same Worker. The kernel
 * uses the pid field in syscall messages to route to the correct process context.
 *
 * MEMORY MANAGEMENT
 * =================
 * Virtual process creates:
 * - Process object (in process table until reaped)
 * - Handle map (cleaned up on exit)
 * - Child map (cleaned up when children exit)
 *
 * No Worker thread is created. Cleanup occurs via exit() or forceExit() which
 * skips worker.terminate() for virtual processes.
 *
 * @module kernel/kernel/create-virtual-process
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { createProcess } from './create-process.js';
import { printk } from './printk.js';
import { EFAULT } from '../errors.js';

/**
 * Create a virtual process.
 *
 * Virtual processes share the parent's Worker but have isolated state.
 * This enables gatewayd to create isolated contexts for external clients.
 *
 * ALGORITHM:
 * 1. Create process object with virtual=true
 * 2. Process inherits parent's Worker
 * 3. Process starts in 'running' state (no Worker startup needed)
 * 4. Register process in global process table
 * 5. Assign PID in parent's namespace
 * 6. Return { pid, id } for caller to use
 *
 * @param self - Kernel instance
 * @param parent - Parent process (creator)
 * @param opts - Optional process configuration
 * @param opts.cwd - Working directory (defaults to parent's cwd)
 * @param opts.env - Environment variables (merged with parent's env)
 * @returns { pid, id } - PID in parent's namespace and process UUID
 */
export function createVirtualProcess(
    self: Kernel,
    parent: Process,
    opts?: {
        cwd?: string;
        env?: Record<string, string>;
    },
): { pid: number; id: string } {
    // =========================================================================
    // STEP 1: Create process object (synchronous)
    // =========================================================================

    const proc = createProcess(self, {
        parent,
        cmd: '[virtual]',  // Marker for debugging
        cwd: opts?.cwd,
        env: opts?.env,
        virtual: true,  // Key flag: shares parent's Worker
    });

    // INVARIANT CHECK: Verify virtual flag and worker inheritance
    if (!proc.virtual) {
        throw new EFAULT('createProcess did not set virtual flag');
    }

    if (proc.worker !== parent.worker) {
        throw new EFAULT('createProcess did not inherit parent worker');
    }

    // =========================================================================
    // STEP 2: Register in process table (synchronous)
    // =========================================================================

    // WHY: Makes process globally visible for syscall routing
    self.processes.register(proc);

    // =========================================================================
    // STEP 3: Assign PID in parent's namespace (atomic, synchronous)
    // =========================================================================

    // WHY ATOMIC: No await between incrementing and setting
    const pid = parent.nextPid++;

    parent.children.set(pid, proc.id);

    // =========================================================================
    // STEP 4: Log creation event
    // =========================================================================

    printk(self, 'spawn', `Virtual process created as PID ${pid} (UUID: ${proc.id.slice(0, 8)})`);

    // Return both PID (for parent's namespace) and UUID (for syscall proxying)
    return { pid, id: proc.id };
}
