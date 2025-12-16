/**
 * Service stdio Setup (Legacy) - VFS-based console handle for service processes
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This is a legacy/alternative stdio setup path for services that uses VFS handles
 * instead of direct console access. It opens /dev/console through the VFS layer
 * and wraps it in a FileHandleAdapter.
 *
 * WHY THIS EXISTS:
 * - Alternative to setup-init-stdio.ts (which uses ConsoleHandleAdapter directly)
 * - Provides VFS-layer access to console (goes through DeviceModel)
 * - Used by some service configurations that prefer VFS path
 *
 * CURRENT STATUS: This appears to be unused in favor of setup-service-io.ts
 * which uses ProcessIOHandle. Consider deprecating if not needed.
 *
 * I/O MODEL
 * =========
 * Unlike setup-init-stdio.ts which uses ConsoleHandleAdapter for direct HAL access,
 * this uses FileHandleAdapter wrapping a VFS handle:
 *
 * Flow: Process → FileHandleAdapter → VFS /dev/console → DeviceModel → HAL console
 *
 * Standard file descriptor setup (one fd at a time):
 * - fd 0 (stdin/recv): VFS read from /dev/console
 * - fd 1 (stdout/send): VFS write to /dev/console
 * - fd 2 (stderr/warn): VFS write to /dev/console
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: /dev/console must exist in VFS before calling this function
 *        VIOLATED BY: DeviceModel not initialized, VFS not mounted
 * INV-2: VFS handle must support read (fd 0) or write (fd 1/2) operations
 *        VIOLATED BY: Wrong flags passed to vfs.open()
 * INV-3: Each call creates exactly one handle with refcount = 1
 *        VIOLATED BY: Handle leak if caller creates duplicate handles
 *
 * CONCURRENCY MODEL
 * =================
 * Called during service spawn, after VFS is initialized but before worker starts.
 * VFS operations are async (await), so theoretically the service could be killed
 * between VFS open and handle mapping. In practice, process isn't running yet so
 * this can't happen.
 *
 * MEMORY MANAGEMENT
 * =================
 * - One FileHandleAdapter created per call (not all three at once)
 * - Adapter wraps VFS handle (VFS owns underlying DeviceModel handle)
 * - Refcount = 1 (service process owns it)
 * - When service exits, kernel decrements refcount and closes handle
 * - FileHandleAdapter.close() delegates to VFS handle cleanup
 *
 * @module kernel/kernel/setup-service-stdio
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { KERNEL_ID } from '../types.js';
import { FileHandleAdapter } from '../handle.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Path to the console device in VFS.
 * WHY: DeviceModel exposes /dev/console as a virtual file that maps to HAL console.
 * Used for init process stdio and service default I/O.
 */
const CONSOLE_PATH = '/dev/console';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Setup a single stdio handle to console for service processes.
 *
 * Opens /dev/console through VFS and creates a FileHandleAdapter wrapping it.
 * Called once per stdio fd (0, 1, or 2) that needs console access.
 *
 * ALGORITHM:
 * 1. Determine open flags: read for stdin (fd 0), write for stdout/stderr (fd 1/2)
 * 2. Open /dev/console through VFS with appropriate flags
 * 3. Wrap VFS handle in FileHandleAdapter
 * 4. Register adapter in kernel.handles table
 * 5. Set refcount = 1
 * 6. Map to process's specified fd number
 *
 * WHY ASYNC: VFS open() is async (may involve filesystem I/O, permission checks).
 *
 * DESIGN CHOICE: Why FileHandleAdapter instead of ConsoleHandleAdapter?
 * - Goes through VFS layer (permission checks, DeviceModel abstraction)
 * - Consistent with other file-based I/O
 * - Allows VFS-level interception (logging, auditing, etc.)
 *
 * EDGE CASE: /dev/console doesn't exist
 * - VFS open() will throw ENOENT
 * - Service spawn fails, kernel logs error
 * - This is fatal because service can't run without stdio
 *
 * @param self - Kernel instance
 * @param proc - Service process (not yet running)
 * @param h - Handle number (0=stdin, 1=stdout, 2=stderr)
 */
export async function setupServiceStdio(
    self: Kernel,
    proc: Process,
    h: number,
): Promise<void> {
    // Determine open flags based on fd number
    // fd 0 (stdin) = read, fd 1/2 (stdout/stderr) = write
    const flags = h === 0 ? { read: true } : { write: true };

    // Open /dev/console through VFS
    // 'kernel' = caller identity (bypasses some permission checks)
    const vfsHandle = await self.vfs.open(CONSOLE_PATH, flags, KERNEL_ID);

    // Wrap VFS handle in adapter
    // Adapter ID reuses VFS handle's ID (no new UUID needed)
    const adapter = new FileHandleAdapter(vfsHandle.id, vfsHandle);

    // Register in kernel table and set refcount
    self.handles.set(adapter.id, adapter);
    self.handleRefs.set(adapter.id, 1);

    // Map to process's fd
    proc.handles.set(h, adapter.id);

    // ATOMICITY: VFS open is atomic, rest is synchronous
    // No race between handle creation and fd mapping
}
