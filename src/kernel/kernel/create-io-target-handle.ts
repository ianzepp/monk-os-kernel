/**
 * I/O Target Handle Factory - Create write handles from service I/O configuration
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Service processes need flexible output targets: console output, log files, or
 * null (discard). This factory creates Handle instances for these output types
 * based on IOTarget configuration.
 *
 * Simpler than createIOSourceHandle because output has fewer types:
 * - console → FileHandleAdapter wrapping VFS /dev/console
 * - file → FileHandleAdapter wrapping VFS file (with create/append options)
 * - null → Inline Handle that discards all writes
 *
 * HANDLE ARCHITECTURE
 * ===================
 * All created handles implement the same Handle interface:
 * - exec(msg) → AsyncIterable<Response>
 * - close() → Promise<void>
 *
 * This allows ProcessIOHandle to treat all targets uniformly. The service code
 * doesn't know if it's writing to console, file, or nowhere - just calls send().
 *
 * FILE OUTPUT FLAGS
 * =================
 * File targets support two flag options:
 * - create: Create file if it doesn't exist (default: true)
 * - append: Append to file instead of truncating (default: false)
 *
 * Common combinations:
 * - { create: true, append: false } - Truncate and overwrite (default)
 * - { create: true, append: true } - Append to log file (log rotation pattern)
 * - { create: false, append: true } - Append only if exists (fail if missing)
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Target type must be one of: console, file, null
 *        VIOLATED BY: Invalid service configuration (validation failure)
 * INV-2: VFS paths (console, file) must be accessible by kernel user
 *        VIOLATED BY: Permission denied, parent directory doesn't exist
 * INV-3: Handle IDs are globally unique UUIDs
 *        VIOLATED BY: UUID collision (extremely unlikely)
 * INV-4: File targets with create=false must exist at open time
 *        VIOLATED BY: File doesn't exist, VFS open fails with ENOENT
 *
 * CONCURRENCY MODEL
 * =================
 * This function is called during service spawn setup (async). Multiple services
 * could be spawning concurrently, each creating their own I/O handles.
 *
 * RACE CONDITION: VFS file operations (await self.vfs.open)
 * - File could be created/deleted between configuration and open
 * - Parent directory could be removed
 * - MITIGATION: VFS open is atomic, fails with appropriate error
 * - Caller handles error (service spawn fails)
 *
 * RACE CONDITION: Multiple services writing to same file
 * - If two services open same log file with append=true
 * - VFS ensures atomic writes (no interleaving within single write)
 * - But message boundaries not preserved across services
 * - MITIGATION: Use unique log files per service, or pubsub → logd
 *
 * MEMORY MANAGEMENT
 * =================
 * - Returns Handle instance (not registered in kernel table)
 * - Caller is responsible for registration and refcounting
 * - FileHandleAdapter holds VFS handle (VFS manages cleanup)
 * - Null target has no underlying resource (inline handle)
 *
 * @module kernel/kernel/create-io-target-handle
 */

import type { Kernel } from '../kernel.js';
import type { IOTarget } from '../services.js';
import type { Handle } from '../handle.js';
import { KERNEL_ID } from '../types.js';
import { respond } from '../../message.js';
import { FileHandleAdapter } from '../handle.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Path to the console device in VFS.
 * WHY: DeviceModel exposes /dev/console for terminal I/O.
 */
const CONSOLE_PATH = '/dev/console';

/**
 * Default file flags: create if missing, truncate if exists.
 * WHY: Most common pattern for service output files.
 */
const DEFAULT_FILE_CREATE = true;
const DEFAULT_FILE_APPEND = false;

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Create a Handle for writing to the specified I/O target.
 *
 * Factory function that dispatches to appropriate Handle type based on
 * IOTarget configuration. Returns Handle instance ready to use.
 *
 * ALGORITHM (by target type):
 *
 * CONSOLE:
 * 1. Open /dev/console with write flag
 * 2. Wrap VFS handle in FileHandleAdapter
 * 3. Return adapter
 *
 * FILE:
 * 1. Determine flags from config (create, append)
 * 2. Open configured file path with write flag
 * 3. Wrap VFS handle in FileHandleAdapter
 * 4. Return adapter
 *
 * NULL:
 * 1. Create inline Handle that discards all writes
 * 2. Return handle (no underlying resource)
 *
 * WHY ASYNC: VFS open operations are async (filesystem I/O, permission checks).
 *
 * DESIGN CHOICE: Why not register handles in kernel table here?
 * - Separation of concerns: this creates, caller registers
 * - Caller knows the fd number and refcount semantics
 * - Allows testing without kernel table mutations
 *
 * DESIGN CHOICE: Why default create=true, append=false?
 * - Most services want fresh output on restart (not append old data)
 * - Log rotation should be external (logrotate-style)
 * - Long-running services use append=true explicitly
 *
 * EDGE CASE: Invalid target type
 * - TypeScript prevents this at compile time
 * - No runtime check needed (discriminated union)
 *
 * EDGE CASE: File parent directory doesn't exist
 * - VFS open will fail with ENOENT
 * - Service spawn fails, kernel logs error
 * - Fatal because service can't run without stdio
 *
 * @param self - Kernel instance
 * @param target - I/O target configuration
 * @returns Handle for writing to target
 */
export async function createIOTargetHandle(
    self: Kernel,
    target: IOTarget,
): Promise<Handle> {
    switch (target.type) {
        // ---------------------------------------------------------------------
        // Console output (terminal stdout/stderr)
        // ---------------------------------------------------------------------
        case 'console': {
            // Open /dev/console through VFS (goes through DeviceModel → HAL console)
            const vfsHandle = await self.vfs.open(CONSOLE_PATH, { write: true }, KERNEL_ID);

            return new FileHandleAdapter(vfsHandle.id, vfsHandle);
        }

        // ---------------------------------------------------------------------
        // File output (write to VFS file)
        // ---------------------------------------------------------------------
        case 'file': {
            // Determine open flags from config (defaults: create=true, append=false)
            const flags = {
                write: true,
                create: target.flags?.create ?? DEFAULT_FILE_CREATE,
                append: target.flags?.append ?? DEFAULT_FILE_APPEND,
            };

            // Open configured file path through VFS
            // If create=true: creates file if missing
            // If append=false: truncates existing file to 0 bytes
            const vfsHandle = await self.vfs.open(target.path, flags, KERNEL_ID);

            // Wrap in adapter for Handle interface
            return new FileHandleAdapter(vfsHandle.id, vfsHandle);
        }

        // ---------------------------------------------------------------------
        // Null output (discard all writes)
        // ---------------------------------------------------------------------
        case 'null': {
            // Inline Handle: exec() yields ok, close() is no-op
            // WHY INLINE: No underlying resource, trivial implementation
            // WHY OK NOT DONE: Write operations return ok (success), not done (stream end)
            return {
                id: self.hal.entropy.uuid(),
                type: 'file' as const,              // Pretend to be file for compatibility
                description: '/dev/null (output)',
                closed: false,
                async *exec() {
                    yield respond.ok();
                }, // Accept write, discard data
                async close() {},                       // Nothing to clean up
            };
        }
    }
}
