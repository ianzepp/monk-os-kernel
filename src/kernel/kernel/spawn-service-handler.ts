/**
 * Service Handler Spawning - Process creation for service activation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module spawns a service handler process when a service is activated.
 * It creates a Process, configures its I/O (stdio or socket-based), loads
 * the handler script into a Bun Worker, and registers the process in the
 * process table.
 *
 * Three I/O modes are supported:
 * 1. Socket mode: TCP connection replaces stdin/stdout/stderr (fd 0/1/2)
 * 2. Configured I/O: Service definition specifies I/O sources/targets
 * 3. Default stdio: Console handles for stdin/stdout/stderr
 *
 * The activation message (if provided) is stored in proc.activationMessage
 * for the handler to read on startup.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Process has exactly one I/O mode (socket XOR configured XOR default)
 *        VIOLATED BY: Multiple I/O setup branches executing
 * INV-2: Process registered in table only after worker starts
 *        VIOLATED BY: Registering before worker spawn completes
 * INV-3: Socket handle has ref count 3 (fd 0, 1, 2 all reference same handle)
 *        VIOLATED BY: Not setting ref count correctly for socket mode
 * INV-4: Handler path exists in VFS before spawn
 *        VIOLATED BY: Not validating handler path (done in loadServicesFromDir)
 * INV-5: Process state is 'running' when registered
 *        VIOLATED BY: Registering process in 'starting' state
 *
 * CONCURRENCY MODEL
 * =================
 * - Spawn is async (worker creation is async)
 * - Multiple handlers can spawn concurrently for same service
 * - Process table is thread-safe (kernel runs in main thread)
 * - I/O setup is sequential (no concurrent access to same process)
 *
 * NOTE: Bun workers are truly parallel (separate threads), not just async.
 * postMessage crosses thread boundaries. The kernel runs in the main thread
 * while each process runs in its own worker thread.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Worker spawn fails after creating process
 *       MITIGATION: Process not registered until worker starts successfully
 * RC-2: Socket closed before handler reads it
 *       MITIGATION: Handle stored in kernel table, ref counted, closed only on last release
 *
 * MEMORY MANAGEMENT
 * =================
 * - Process created and registered (owned by process table)
 * - Socket handle (if present) owned by kernel handle table, ref counted
 * - Worker owned by Process (cleaned up on process exit)
 * - Activation message stored in Process (no separate allocation)
 *
 * TESTABILITY
 * ===========
 * - Deps can be mocked (createProcess, setupServiceIO, spawnWorker)
 * - Socket adapter creation testable via mock socket
 * - Process registration verifiable via process table
 *
 * @module kernel/kernel/spawn-service-handler
 */

import type { Kernel } from '../kernel.js';
import type { ServiceDef } from '../services.js';
import type { Socket } from '../../hal/network.js';
import type { Message } from '../../message.js';
import { SocketHandleAdapter } from '../handle.js';
import { createProcess } from './create-process.js';
import { setupServiceIO } from './setup-service-io.js';
import { setupServiceStdio } from './setup-service-stdio.js';
import { spawnWorker } from './spawn-worker.js';
import { printk } from './printk.js';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Spawn a service handler process.
 *
 * ALGORITHM:
 * 1. Resolve handler path (.ts extension)
 * 2. Create Process with UUID and cmd
 * 3. Store activation message in Process (if provided)
 * 4. Configure I/O (socket mode OR configured I/O OR default stdio)
 * 5. Spawn Bun Worker with handler script
 * 6. Set process state to 'running'
 * 7. Register process in table
 *
 * I/O MODES:
 * - Socket mode: fd 0/1/2 all point to same SocketHandleAdapter
 * - Configured I/O: Use service definition io.stdin/stdout/stderr
 * - Default stdio: fd 0/1/2 point to console handles
 *
 * @param self - Kernel instance
 * @param name - Service name
 * @param def - Service definition with handler path and I/O config
 * @param socket - Optional TCP socket for socket activation
 * @param activation - Optional activation message (TCP/UDP/pubsub/watch event)
 */
export async function spawnServiceHandler(
    self: Kernel,
    name: string,
    def: ServiceDef,
    socket?: Socket,
    activation?: Message
): Promise<void> {
    // -------------------------------------------------------------------------
    // Resolve handler path
    // -------------------------------------------------------------------------

    // WHY: Support both '/bin/handler' and '/bin/handler.ts' in config
    const entry = def.handler.endsWith('.ts') ? def.handler : def.handler + '.ts';

    // -------------------------------------------------------------------------
    // Create process
    // -------------------------------------------------------------------------

    const proc = createProcess(self, { cmd: def.handler });

    // WHY: Store activation message for handler to read on startup
    //      (TCP connection info, pubsub topic, watch event, etc.)
    proc.activationMessage = activation;

    // -------------------------------------------------------------------------
    // Configure I/O (socket OR configured OR default)
    // -------------------------------------------------------------------------

    if (socket) {
        // =====================================================================
        // SOCKET MODE (TCP activation)
        // =====================================================================

        // WHY: Socket becomes stdin/stdout/stderr (fd 0/1/2)
        //      Handler reads from socket, writes to socket
        const stat = socket.stat();
        const description = `tcp:${stat.remoteAddr}:${stat.remotePort}`;
        const adapter = new SocketHandleAdapter(self.hal.entropy.uuid(), socket, description);

        // Register handle in kernel table
        self.handles.set(adapter.id, adapter);

        // WHY: Ref count 3 because fd 0, 1, 2 all reference same handle
        self.handleRefs.set(adapter.id, 3);

        // Map all stdio fds to socket handle
        proc.handles.set(0, adapter.id);
        proc.handles.set(1, adapter.id);
        proc.handles.set(2, adapter.id);

    } else if (def.io) {
        // =====================================================================
        // CONFIGURED I/O MODE
        // =====================================================================

        // WHY: Service definition specifies I/O sources (stdin) and targets (stdout/stderr)
        //      Examples: pubsub subscribe, file write, console, null device
        await setupServiceIO(self, proc, def);

    } else {
        // =====================================================================
        // DEFAULT STDIO MODE
        // =====================================================================

        // WHY: No socket, no configured I/O -> use console handles
        await setupServiceStdio(self, proc, 0);
        await setupServiceStdio(self, proc, 1);
        await setupServiceStdio(self, proc, 2);
    }

    // -------------------------------------------------------------------------
    // Spawn worker
    // -------------------------------------------------------------------------

    printk(self, 'spawn', `${name}: spawning worker for ${entry}`);
    proc.worker = await spawnWorker(self, proc, entry);

    // -------------------------------------------------------------------------
    // Mark running and register
    // -------------------------------------------------------------------------

    // WHY: Process must be 'running' before registration
    //      Syscalls can only run on running processes
    proc.state = 'running';
    printk(self, 'spawn', `${name}: worker started (${proc.id.slice(0, 8)})`);

    // WHY: Registration makes process visible to syscalls (getpid, wait, etc.)
    self.processes.register(proc);
}
