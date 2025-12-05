/**
 * Init Process stdio Setup - Bootstrap console I/O for the first process
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The init process is special: it's the first userland process spawned by the
 * kernel and has no parent to inherit stdio from. This module creates fresh
 * console handles (stdin/stdout/stderr) that connect directly to the host OS
 * terminal via HAL ConsoleDevice.
 *
 * Init's stdio becomes the root of the inheritance chain for all future processes.
 * When init spawns a child, that child inherits init's console handles, and so on.
 *
 * I/O MODEL - MESSAGE/BYTE BOUNDARY
 * ==================================
 * This is where Monk OS's message-based I/O meets the host OS's byte streams:
 *
 * ConsoleHandleAdapter wraps HAL ConsoleDevice and performs translation:
 * - Inbound: bytes from terminal → Response messages to process
 * - Outbound: Response messages from process → bytes to terminal
 *
 * Standard file descriptor setup (fd 0/1/2):
 * - fd 0 (stdin/recv): Read bytes from console, deliver as message stream
 * - fd 1 (stdout/send): Receive messages from process, write bytes to console
 * - fd 2 (stderr/warn): Receive messages from process, write bytes to console
 *
 * WHY SEPARATE HANDLES FOR EACH FD?
 * Each fd (0/1/2) gets its own ConsoleHandleAdapter instance because they map
 * to different underlying devices (stdin vs stdout vs stderr in HAL). This allows
 * proper separation: stderr can be redirected independently of stdout.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Init process has exactly one reference to each stdio handle
 *        VIOLATED BY: Multiple refs would prevent cleanup on init exit
 * INV-2: All three stdio handles (0/1/2) must be created successfully
 *        VIOLATED BY: Kernel panic if any handle creation fails (init can't run)
 * INV-3: Handle IDs are globally unique UUIDs
 *        VIOLATED BY: Collision would break kernel handle table
 * INV-4: Handles registered in kernel table before mapping to process fds
 *        VIOLATED BY: Process could try to use unmapped handle
 *
 * CONCURRENCY MODEL
 * =================
 * This function is called synchronously during kernel boot, before any processes
 * exist. No concurrency concerns. Init process worker hasn't started yet.
 *
 * MEMORY MANAGEMENT
 * =================
 * - Three ConsoleHandleAdapter instances created (one per fd)
 * - Each registered in kernel.handles (global table)
 * - Each gets refcount = 1 (init owns it)
 * - When init exits, kernel decrements refcounts and closes all handles
 * - ConsoleHandleAdapter.close() releases HAL console resources
 *
 * @module kernel/kernel/setup-init-stdio
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { ConsoleHandleAdapter } from '../handle.js';

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
 * Setup stdio handles for init process with direct console access.
 *
 * Creates three ConsoleHandleAdapter instances (stdin, stdout, stderr) and
 * registers them with the kernel, then maps them to init's fds 0/1/2.
 *
 * ALGORITHM:
 * 1. Create stdin adapter (console input → messages)
 *    a. Generate unique UUID for handle
 *    b. Wrap HAL console device with 'stdin' mode
 *    c. Register in kernel.handles table
 *    d. Set refcount = 1
 *    e. Map to init's fd 0
 * 2. Create stdout adapter (messages → console output)
 *    a-e. Same as stdin but with 'stdout' mode and fd 1
 * 3. Create stderr adapter (messages → console error output)
 *    a-e. Same as stdin but with 'stderr' mode and fd 2
 * 4. Return (no async operations, atomic setup)
 *
 * WHY ASYNC: Not actually async (no await calls), but marked async for
 * consistency with other setup functions that may do async VFS operations.
 *
 * DESIGN CHOICE: Why ConsoleHandleAdapter instead of FileHandleAdapter?
 * - ConsoleDevice is not in VFS (/dev/console is separate)
 * - ConsoleHandleAdapter provides direct HAL access without VFS overhead
 * - Simpler and faster for bootstrap path
 *
 * ORDERING: Why register handle before mapping fd?
 * - Kernel table is the source of truth
 * - Process fd mapping is just a local reference
 * - If kernel doesn't know about handle, process can't use it
 *
 * @param self - Kernel instance
 * @param init - Init process (not yet running, no handles set)
 */
export async function setupInitStdio(self: Kernel, init: Process): Promise<void> {
    // -------------------------------------------------------------------------
    // Setup stdin (fd 0)
    // -------------------------------------------------------------------------
    const stdinAdapter = new ConsoleHandleAdapter(
        self.hal.entropy.uuid(),      // Generate globally unique handle ID
        self.hal.console,              // HAL console device
        'stdin',                        // Read mode (host stdin → messages)
    );

    self.handles.set(stdinAdapter.id, stdinAdapter);  // Register in kernel table
    self.handleRefs.set(stdinAdapter.id, 1);          // Init owns this handle (refcount = 1)
    init.handles.set(STDIN_FD, stdinAdapter.id);      // Map init's fd 0 → handle UUID

    // -------------------------------------------------------------------------
    // Setup stdout (fd 1)
    // -------------------------------------------------------------------------
    const stdoutAdapter = new ConsoleHandleAdapter(
        self.hal.entropy.uuid(),
        self.hal.console,
        'stdout',                       // Write mode (messages → host stdout)
    );

    self.handles.set(stdoutAdapter.id, stdoutAdapter);
    self.handleRefs.set(stdoutAdapter.id, 1);
    init.handles.set(STDOUT_FD, stdoutAdapter.id);

    // -------------------------------------------------------------------------
    // Setup stderr (fd 2)
    // -------------------------------------------------------------------------
    const stderrAdapter = new ConsoleHandleAdapter(
        self.hal.entropy.uuid(),
        self.hal.console,
        'stderr',                       // Write mode (messages → host stderr)
    );

    self.handles.set(stderrAdapter.id, stderrAdapter);
    self.handleRefs.set(stderrAdapter.id, 1);
    init.handles.set(STDERR_FD, stderrAdapter.id);

    // ATOMICITY: All three handles created in single function call
    // No other code can run between handle creation and fd mapping
    // Init's stdio is fully set up when this function returns
}
