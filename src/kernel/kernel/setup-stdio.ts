/**
 * Process stdio Inheritance - Setup standard file descriptors for child process
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * When spawning a new process, the child inherits stdio handles from its parent by
 * default. This creates a chain: kernel → init → services → user processes. Each
 * process's stdin/stdout/stderr are Unix-style file descriptors (0/1/2) that map
 * to kernel-managed handles (UUIDs). This module handles the atomic setup of these
 * mappings and ensures reference counting prevents premature cleanup.
 *
 * I/O MODEL
 * =========
 * Monk OS uses message-based I/O internally, not byte streams. File descriptors
 * are renamed to reflect this:
 * - fd 0: recv (receive messages from stdin)
 * - fd 1: send (send messages to stdout)
 * - fd 2: warn (send diagnostics to stderr)
 *
 * Despite the terminology, these map to standard Unix fds (0/1/2) for compatibility.
 * The kernel translates between message and byte representations at I/O boundaries.
 *
 * HANDLE LIFECYCLE
 * ================
 * Handles are reference-counted kernel objects. When a process inherits a handle:
 * 1. Parent's fd → handle UUID mapping is copied to child
 * 2. Handle's reference count is incremented
 * 3. When child closes fd or exits, refcount decrements
 * 4. Handle is destroyed when refcount reaches 0
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Parent process must exist and be valid when child spawns
 *        VIOLATED BY: Parent exit racing with child spawn
 * INV-2: If parent has fd N mapped, the handle UUID must exist in kernel table
 *        VIOLATED BY: Handle cleanup without unmapping fd, kernel state corruption
 * INV-3: Reference count incremented atomically with fd mapping
 *        VIOLATED BY: Mapping fd without incrementing refcount (premature cleanup)
 * INV-4: stdio fds (0/1/2) are the only fds set by this function
 *        VIOLATED BY: Modifying other fds in child process
 *
 * CONCURRENCY MODEL
 * =================
 * This function is called synchronously during process spawn, before the worker
 * thread is created. No concurrent access to proc.handles is possible yet.
 * However, the parent process may be running concurrently and could theoretically
 * close handles while we're setting them up.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: We read parent.handles and increment refcounts atomically in the same
 *       call stack. Parent cannot close handles between our read and refcount
 *       increment because JavaScript is single-threaded and we don't await.
 * RC-2: If parent's handle doesn't exist (shouldn't happen), we log a warning
 *       and continue. Child runs with missing stdio but doesn't crash.
 *
 * MEMORY MANAGEMENT
 * =================
 * - Handles are NOT copied, only references are shared
 * - Reference count prevents cleanup while child is using handle
 * - Child's process.handles.clear() on exit decrements all refs automatically
 * - No manual cleanup needed in this module
 *
 * @module kernel/kernel/setup-stdio
 */

import type { Kernel } from '../kernel.js';
import type { Process, SpawnOpts } from '../types.js';
import { refHandle } from './ref-handle.js';
import { printk } from './printk.js';

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
 * Setup standard I/O file descriptors for a new process.
 *
 * Inherits stdio from parent process unless overridden in opts. Each fd maps
 * to the same handle UUID as the parent, with reference count incremented.
 *
 * ALGORITHM:
 * 1. Determine source fds from opts or defaults (parent's 0/1/2)
 * 2. For each stdio fd (stdin/stdout/stderr):
 *    a. Look up parent's handle UUID for that fd
 *    b. If found: map child's fd → same UUID, increment refcount
 *    c. If missing: log warning, child gets no handle for that fd
 * 3. Return (no async operations, atomic setup)
 *
 * DESIGN CHOICE: Why not create new handles for each child?
 * - Sharing handles enables pipelines: parent's stdout → child's stdin
 * - Reference counting ensures handles live as long as any process uses them
 * - Copying would break message streams between processes
 *
 * EDGE CASE: Parent missing stdio handle
 * - Shouldn't happen in normal operation (init always has stdio)
 * - Log warning for debugging, continue setup for other fds
 * - Child can still spawn successfully, just missing that stdio fd
 *
 * @param self - Kernel instance
 * @param proc - New child process (not yet running)
 * @param parent - Parent process (running)
 * @param opts - Spawn options (may override stdio)
 */
export function setupStdio(
    self: Kernel,
    proc: Process,
    parent: Process,
    opts?: SpawnOpts,
): void {
    // Determine which parent fds to inherit from (default: 0/1/2)
    // NOTE: SpawnOpts allows overriding stdio, e.g., redirect stdout to different fd
    const stdinSource = opts?.stdin ?? STDIN_FD;
    const stdoutSource = opts?.stdout ?? STDOUT_FD;
    const stderrSource = opts?.stderr ?? STDERR_FD;

    // -------------------------------------------------------------------------
    // Setup stdin (fd 0)
    // -------------------------------------------------------------------------
    if (typeof stdinSource === 'number') {
        setupStdioFd(self, proc, parent, STDIN_FD, stdinSource, 'stdin');
    }
    // TODO: Handle stdinSource === 'pipe' (create new pipe, give write end to parent)

    // -------------------------------------------------------------------------
    // Setup stdout (fd 1)
    // -------------------------------------------------------------------------
    if (typeof stdoutSource === 'number') {
        setupStdioFd(self, proc, parent, STDOUT_FD, stdoutSource, 'stdout');
    }
    // TODO: Handle stdoutSource === 'pipe'

    // -------------------------------------------------------------------------
    // Setup stderr (fd 2)
    // -------------------------------------------------------------------------
    if (typeof stderrSource === 'number') {
        setupStdioFd(self, proc, parent, STDERR_FD, stderrSource, 'stderr');
    }
    // TODO: Handle stderrSource === 'pipe'
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Setup a single stdio file descriptor by inheriting from parent.
 *
 * WHY: Extracted to reduce duplication across stdin/stdout/stderr setup.
 *
 * ATOMICITY: This function performs two operations that must stay together:
 * 1. Map child's fd → parent's handle UUID
 * 2. Increment handle's reference count
 * If we only did (1), the handle could be destroyed while child is using it.
 *
 * @param self - Kernel instance
 * @param proc - Child process
 * @param parent - Parent process
 * @param childFd - Child's fd number (0, 1, or 2)
 * @param parentFd - Parent's fd number to inherit from
 * @param name - Human-readable name for logging (stdin/stdout/stderr)
 */
function setupStdioFd(
    self: Kernel,
    proc: Process,
    parent: Process,
    childFd: number,
    parentFd: number,
    name: string,
): void {
    // Look up parent's handle for this fd
    const handleId = parent.handles.get(parentFd);

    if (handleId) {
        // SUCCESS PATH: Parent has handle, inherit it
        proc.handles.set(childFd, handleId);
        refHandle(self, handleId); // Increment reference count
    }
    else {
        // ERROR PATH: Parent missing handle (shouldn't happen)
        // WHY LOG: This indicates kernel state corruption or init spawn bug
        // WHY CONTINUE: Child can still run, just missing this stdio fd
        printk(
            self,
            'warn',
            `Parent ${parent.cmd} missing ${name} handle at fd ${parentFd}, child ${proc.cmd} will have no ${name}`,
        );
    }
}
