/**
 * Process Spawning - Create and start a child process
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Spawning is the primary mechanism for creating new processes. This function
 * orchestrates the complete process creation sequence: object creation, stdio
 * setup, worker thread creation, registration, and PID assignment. The spawned
 * process begins executing immediately in its own Bun Worker thread.
 *
 * STATE MACHINE
 * =============
 * Process transitions through these states during spawn:
 *   [call spawn]
 *        |
 *        v
 *   createProcess() --> starting
 *        |
 *   setupStdio() (no state change)
 *        |
 *   spawnWorker() --> running
 *        |
 *   register() (no state change)
 *        |
 *   assignPID() --> [return PID]
 *
 * INVARIANTS
 * ==========
 * INV-1: Process must be registered before returning PID
 *        VIOLATED BY: Returning before registration completes
 * INV-2: Process state must be 'running' when returning
 *        VIOLATED BY: Returning while state is 'starting'
 * INV-3: PID must be unique within parent's namespace
 *        VIOLATED BY: Not incrementing nextPid atomically
 * INV-4: Worker must be created before setting state to 'running'
 *        VIOLATED BY: Setting state before worker is ready
 * INV-5: Parent must track child in its children map
 *        VIOLATED BY: Not adding to parent.children
 *
 * CONCURRENCY MODEL
 * =================
 * This function is async and must handle potential interleaving:
 *
 * 1. SAFE: createProcess() - synchronous, no race
 * 2. SAFE: setupStdio() - synchronous, modifies new (unreachable) process
 * 3. CRITICAL: spawnWorker() - async, but process not yet registered
 * 4. CRITICAL: register() - makes process globally visible
 * 5. SAFE: PID assignment - no await between increment and set
 *
 * NOTE: Bun workers are truly parallel (separate threads), not just async.
 * The worker starts executing immediately in a separate thread once created.
 * The kernel runs in the main thread and manages worker lifecycle.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: PID assignment is atomic (no await between increment and map.set)
 *       WHY: Prevents duplicate PIDs if multiple spawns occur concurrently
 * RC-2: Process registered AFTER worker is ready (state='running')
 *       WHY: Process should only be queryable when actually executable
 * RC-3: Process object not shared until after registration
 *       WHY: Prevents access to partially initialized process
 *
 * MEMORY MANAGEMENT
 * =================
 * Creates several persistent structures:
 * - Process object (in process table until reaped)
 * - Worker thread (until terminated in exit/forceExit)
 * - Parent->child mapping (until child is reaped)
 * - stdio handles (until process exits)
 *
 * Cleanup occurs in:
 * - exit() for graceful shutdown
 * - forceExit() for immediate shutdown
 * - reapZombie() for final cleanup
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
 * Spawn a child process in a new Bun Worker thread.
 *
 * WHY ASYNC: Worker creation and script loading are asynchronous operations.
 * WHY RETURN PID: Parent needs PID to wait() or kill() the child later.
 * WHY STDIO SETUP: Process needs I/O channels before it can communicate.
 * WHY REGISTER AFTER WORKER: Process should be queryable only when running.
 *
 * ALGORITHM:
 * 1. Create process object in 'starting' state
 * 2. Setup stdio (inherit from parent or create pipes per opts)
 * 3. Create worker and load entry point (async)
 * 4. Transition process to 'running' state
 * 5. Register process in global process table
 * 6. Assign PID in parent's namespace (atomic)
 * 7. Log spawn event for debugging
 * 8. Return PID for parent to track child
 *
 * RACE CONDITION:
 * The worker may start executing before we finish registration. This is safe
 * because:
 * - Process can only make syscalls AFTER it's registered (checked in dispatch)
 * - Worker thread has its own memory (no shared state corruption)
 * - State transition 'starting' -> 'running' happens before registration
 *
 * @param self - Kernel instance
 * @param parent - Parent process (caller)
 * @param entry - Entry point path in VFS (e.g., '/bin/shell')
 * @param opts - Spawn options (stdio, cwd, env, args)
 * @returns PID in parent's namespace (positive integer)
 *
 * @throws ENOENT - Entry point does not exist
 * @throws EACCES - Entry point is not executable
 * @throws Error - Worker creation failed
 */
export async function spawn(
    self: Kernel,
    parent: Process,
    entry: string,
    opts?: SpawnOpts
): Promise<number> {
    // =========================================================================
    // STEP 1: Create process object (synchronous)
    // =========================================================================

    const proc = createProcess(self, {
        parent,
        cmd: entry,
        cwd: opts?.cwd,
        env: opts?.env,
        args: opts?.args,
    });

    // =========================================================================
    // STEP 2: Setup stdio channels (synchronous)
    // =========================================================================

    // WHY: Process needs I/O before worker starts executing
    // INHERIT: By default, child shares parent's stdin/stdout/stderr
    setupStdio(self, proc, parent, opts);

    // =========================================================================
    // STEP 3: Create and start worker thread (asynchronous)
    // =========================================================================

    // WHY AWAIT: Worker creation is async (blob creation, script loading)
    // CRITICAL: Process is not yet visible to rest of system
    proc.worker = await spawnWorker(self, proc, entry);

    // WHY NOW: Worker is ready, can receive syscalls
    proc.state = 'running';

    // =========================================================================
    // STEP 4: Register in process table (synchronous)
    // =========================================================================

    // WHY AFTER WORKER: Process should be queryable only when actually running
    // SIDE EFFECT: Makes process globally visible via processes.get(id)
    self.processes.register(proc);

    // =========================================================================
    // STEP 5: Assign PID in parent's namespace (atomic, synchronous)
    // =========================================================================

    // WHY ATOMIC: No await between incrementing and setting
    // RACE FIX: Prevents duplicate PIDs if multiple spawns occur in parallel
    const pid = parent.nextPid++;
    parent.children.set(pid, proc.id);

    // =========================================================================
    // STEP 6: Log spawn event
    // =========================================================================

    printk(self, 'spawn', `${entry} started as PID ${pid} (UUID: ${proc.id.slice(0, 8)})`);

    return pid;
}
