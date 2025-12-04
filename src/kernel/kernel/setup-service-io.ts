/**
 * Service I/O Setup - Configure stdio with activation sources and output targets
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Services (daemons) need more sophisticated I/O than regular processes. Instead of
 * inheriting parent's stdio, services declare their I/O configuration in /etc/services/*.json:
 * - stdin can be: console, file, pubsub topic, file watch, UDP socket, or null
 * - stdout can be: console, file, or null
 * - stderr can be: console, file, or null
 *
 * This module creates ProcessIOHandle instances that wrap these configured sources/targets.
 * ProcessIOHandle provides the unified Handle interface while routing to the appropriate
 * underlying I/O primitive (port, file, console, etc.).
 *
 * SERVICE I/O MODEL
 * =================
 * Service stdio differs from normal process stdio in two ways:
 *
 * 1. ACTIVATION-DRIVEN INPUT (stdin/fd 0):
 *    - Service may be spawned when TCP connection arrives (socket activation)
 *    - Or when file changes detected (watch activation)
 *    - Or when pubsub message published (topic activation)
 *    - stdin receives these activation events as messages
 *
 * 2. PERSISTENT OUTPUT (stdout/stderr, fd 1/2):
 *    - Service output may go to log files, not console
 *    - Or be discarded with /dev/null
 *    - Or still use console for debugging
 *
 * Standard file descriptor setup (fd 0/1/2):
 * - fd 0 (stdin/recv): Read from configured IOSource (default: console)
 * - fd 1 (stdout/send): Write to configured IOTarget (default: console)
 * - fd 2 (stderr/warn): Write to configured IOTarget (default: console)
 *
 * WHY ProcessIOHandle?
 * - Provides unified Handle interface for heterogeneous I/O
 * - Service code doesn't know if stdin is console, port, or file
 * - Kernel can swap I/O implementation without changing service
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All three stdio handles (0/1/2) must be created successfully
 *        VIOLATED BY: I/O source/target creation failure (fatal to service)
 * INV-2: Each handle has refcount = 1 (service owns it)
 *        VIOLATED BY: Double registration, refcount leak
 * INV-3: Handle IDs are globally unique UUIDs
 *        VIOLATED BY: UUID collision (extremely unlikely)
 * INV-4: IOSource/IOTarget configurations are valid before this function runs
 *        VIOLATED BY: Invalid service definition (caller's responsibility)
 *
 * CONCURRENCY MODEL
 * =================
 * Called during service spawn, before worker starts. Uses async operations to create
 * I/O handles (may involve VFS open, network bind, etc.). Service process doesn't
 * run until this function completes, so no race with service code.
 *
 * RACE CONDITION: Service could be killed by external signal while we're setting up I/O.
 * MITIGATION: Kernel marks process as 'starting', ignores kill until setup complete.
 *
 * MEMORY MANAGEMENT
 * =================
 * - Three ProcessIOHandle instances created (stdin, stdout, stderr)
 * - Each registered in kernel.handles table
 * - Each gets refcount = 1 (service owns it)
 * - ProcessIOHandle holds references to underlying source/target handles
 * - When service exits, kernel decrements refcounts and closes all handles
 * - ProcessIOHandle.close() cascades to underlying handles
 *
 * @module kernel/kernel/setup-service-io
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { ServiceDef } from '../services.js';
import { ProcessIOHandle } from '../handle.js';
import { createIOSourceHandle } from './create-io-source-handle.js';
import { createIOTargetHandle } from './create-io-target-handle.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Standard file descriptor for stdin (receive).
 * WHY: Unix convention, used by all POSIX programs.
 */
const STDIN_FD = 0;

/**
 * Standard file descriptor for stdout (send).
 * WHY: Unix convention, used by all POSIX programs.
 */
const STDOUT_FD = 1;

/**
 * Standard file descriptor for stderr (warn).
 * WHY: Unix convention, used by all POSIX programs.
 */
const STDERR_FD = 2;

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Setup service stdio using ProcessIOHandle with configured sources/targets.
 *
 * Creates three ProcessIOHandle instances (stdin, stdout, stderr) based on
 * service definition, or defaults to console if not specified.
 *
 * ALGORITHM:
 * 1. Create stdin source handle from config (or default to console)
 * 2. Wrap in ProcessIOHandle and register with kernel
 * 3. Map to process fd 0
 * 4. Create stdout target handle from config (or default to console)
 * 5. Wrap in ProcessIOHandle and register with kernel
 * 6. Map to process fd 1
 * 7. Create stderr target handle from config (or default to console)
 * 8. Wrap in ProcessIOHandle and register with kernel
 * 9. Map to process fd 2
 *
 * WHY ASYNC: createIOSourceHandle and createIOTargetHandle are async (may open
 * files, bind ports, subscribe to topics, etc.).
 *
 * DESIGN CHOICE: Why create source before target?
 * - Input is often activation-driven (service wakes on input)
 * - Want input ready before service starts running
 * - Output can be buffered if needed
 * - No technical requirement, just logical ordering
 *
 * DESIGN CHOICE: Why separate source and target helpers?
 * - Different configuration schemas (IOSource vs IOTarget)
 * - Different handle types (ports vs files)
 * - Clear separation of concerns
 *
 * EDGE CASE: I/O configuration invalid
 * - createIOSourceHandle or createIOTargetHandle will throw
 * - Service spawn fails, kernel logs error
 * - Fatal because service can't run without stdio
 *
 * @param self - Kernel instance
 * @param proc - Service process (not yet running)
 * @param def - Service definition with I/O configuration
 */
export async function setupServiceIO(
    self: Kernel,
    proc: Process,
    def: ServiceDef
): Promise<void> {
    // Get I/O config from service definition (may be undefined)
    const io = def.io ?? {};

    // -------------------------------------------------------------------------
    // Setup stdin (fd 0) - Input source
    // -------------------------------------------------------------------------
    // Create underlying source handle (port, file, console, etc.)
    const stdinSource = io.stdin
        ? await createIOSourceHandle(self, io.stdin, proc)
        : await createIOSourceHandle(self, { type: 'console' }, proc);

    // Wrap in ProcessIOHandle for unified interface
    const stdinHandle = new ProcessIOHandle(
        self.hal.entropy.uuid(),
        `stdin:${proc.cmd}`,           // Human-readable description
        { source: stdinSource }        // Read-only (no target)
    );

    // Register in kernel table and map to process fd 0
    self.handles.set(stdinHandle.id, stdinHandle);
    self.handleRefs.set(stdinHandle.id, 1);
    proc.handles.set(STDIN_FD, stdinHandle.id);

    // -------------------------------------------------------------------------
    // Setup stdout (fd 1) - Output target
    // -------------------------------------------------------------------------
    // Create underlying target handle (file, console, null, etc.)
    const stdoutTarget = io.stdout
        ? await createIOTargetHandle(self, io.stdout)
        : await createIOTargetHandle(self, { type: 'console' });

    // Wrap in ProcessIOHandle for unified interface
    const stdoutHandle = new ProcessIOHandle(
        self.hal.entropy.uuid(),
        `stdout:${proc.cmd}`,
        { target: stdoutTarget }       // Write-only (no source)
    );

    // Register in kernel table and map to process fd 1
    self.handles.set(stdoutHandle.id, stdoutHandle);
    self.handleRefs.set(stdoutHandle.id, 1);
    proc.handles.set(STDOUT_FD, stdoutHandle.id);

    // -------------------------------------------------------------------------
    // Setup stderr (fd 2) - Error output target
    // -------------------------------------------------------------------------
    // Create underlying target handle (file, console, null, etc.)
    const stderrTarget = io.stderr
        ? await createIOTargetHandle(self, io.stderr)
        : await createIOTargetHandle(self, { type: 'console' });

    // Wrap in ProcessIOHandle for unified interface
    const stderrHandle = new ProcessIOHandle(
        self.hal.entropy.uuid(),
        `stderr:${proc.cmd}`,
        { target: stderrTarget }
    );

    // Register in kernel table and map to process fd 2
    self.handles.set(stderrHandle.id, stderrHandle);
    self.handleRefs.set(stderrHandle.id, 1);
    proc.handles.set(STDERR_FD, stderrHandle.id);

    // ATOMICITY: All three handles created in single async function
    // Service process doesn't start until this returns
    // No partial stdio state visible to service
}
