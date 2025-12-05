/**
 * File Open Syscall - Open VFS files and allocate file descriptors
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Processes access the VFS through file descriptors. This syscall opens a file
 * at the specified path with the specified flags, wraps the VFS handle in a
 * FileHandleAdapter, and allocates a file descriptor for the calling process.
 *
 * This is the primary entry point for all VFS file access: regular files,
 * directories, devices (/dev/*), proc files (/proc/*), and more.
 *
 * VFS PATH RESOLUTION
 * ===================
 * The VFS resolves paths through:
 * 1. Mount table (maps paths to models)
 * 2. Model dispatch (FileModel, FolderModel, DeviceModel, ProcModel, LinkModel)
 * 3. Entity lookup (UUID-based, indexed by parent+name)
 *
 * Common paths:
 * - /home/user/file.txt → FileModel (entity-backed)
 * - /dev/console → DeviceModel (HAL console)
 * - /proc/self/stat → ProcModel (virtual, runtime generated)
 *
 * OPEN FLAGS
 * ==========
 * Flags control how file is opened and what operations are allowed:
 * - read: Allow read operations
 * - write: Allow write operations
 * - create: Create file if it doesn't exist
 * - append: Append to file instead of overwriting
 * - truncate: Truncate file to 0 bytes on open
 * - excl: Fail if file exists (with create)
 *
 * ASYNC OPERATION
 * ===============
 * File opening is ASYNC because VFS operations are async:
 * - Path resolution (may cross mount points)
 * - Entity lookup (database query)
 * - Permission checks (ACL evaluation)
 * - File creation (database insert if create=true)
 *
 * CRITICAL: State changes after await. Process could be killed while we're
 * opening the file. Always check process state after async operations.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Path must exist or create flag must be set
 *        VIOLATED BY: VFS open() throws ENOENT
 * INV-2: Process must have permission to access file
 *        VIOLATED BY: VFS open() throws EPERM
 * INV-3: File handle must be allocated or VFS handle must be closed
 *        VIOLATED BY: Handle leak (VFS handle open but no fd)
 * INV-4: VFS handle ID must match adapter ID
 *        VIOLATED BY: Adapter wraps wrong handle (logic error)
 *
 * CONCURRENCY MODEL
 * =================
 * This is a syscall executed by a running process. Process worker thread blocks
 * waiting for response. Multiple processes could open files concurrently.
 *
 * RACE CONDITION: Process killed during VFS open
 * - Process calls openFile(), we await vfs.open()
 * - While waiting (path resolution, entity lookup), process receives SIGKILL
 * - We wake up with open VFS handle, try to allocate fd
 * - Process is dead, can't map fd
 * - MITIGATION: Currently not detected - VFS handle leaks (TODO)
 * - BETTER: Check process.state after await, close handle if dead
 *
 * RACE CONDITION: File deleted between open and use
 * - VFS open succeeds, handle valid
 * - Another process deletes file
 * - Original process tries to read/write
 * - MITIGATION: VFS handles keep reference to entity (soft delete)
 * - File data remains accessible until all handles closed
 *
 * RACE CONDITION: Permission changes after open
 * - VFS open succeeds with permissions checked
 * - Another process revokes permissions
 * - Original process still has handle
 * - MITIGATION: Permissions checked at open time only (capability model)
 * - Once opened, handle is capability to access file
 *
 * MEMORY MANAGEMENT
 * =================
 * - Creates VFS FileHandle (model-specific, managed by VFS)
 * - Wraps in FileHandleAdapter for kernel Handle interface
 * - Registers adapter in kernel.handles table
 * - Sets refcount = 1 (process owns it)
 * - Returns fd number to process
 * - When process closes fd or exits, kernel decrements refcount
 * - FileHandleAdapter.close() delegates to VFS handle cleanup
 *
 * @module kernel/kernel/open-file
 */

import type { Kernel } from '../kernel.js';
import type { Process, OpenFlags } from '../types.js';
import { FileHandleAdapter } from '../handle.js';
import { allocHandle } from './alloc-handle.js';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Open a VFS file and allocate a file descriptor.
 *
 * Syscall handler that opens file at path with specified flags, wraps VFS handle
 * in adapter, and returns fd number to calling process.
 *
 * ALGORITHM:
 * 1. Call vfs.open(path, flags, proc.id) to open file (ASYNC)
 * 2. Create FileHandleAdapter wrapping VFS handle
 * 3. Allocate fd and register handle in kernel table
 * 4. Return fd number
 *
 * WHY ASYNC: VFS operations are async (path resolution, entity lookup, permission
 * checks, database operations for create/truncate).
 *
 * DESIGN CHOICE: Why pass proc.user to vfs.open?
 * - VFS needs user identity for permission checks (ACL evaluation)
 * - All processes running as same user share file permissions
 * - proc.id is process-specific, proc.user is identity (e.g., 'root')
 *
 * DESIGN CHOICE: Why allocate fd after VFS open?
 * - VFS open might fail (ENOENT, EPERM, etc.)
 * - Don't want fd allocated if open fails
 * - Easier cleanup: no fd to unmap on error
 * - VFS handle is already created, just need to wrap it
 *
 * DESIGN CHOICE: Why reuse VFS handle ID for adapter?
 * - VFS handle already has unique ID
 * - Avoids allocating second UUID
 * - Makes debugging easier (same ID in VFS and kernel tables)
 * - Adapter is thin wrapper, should be transparent
 *
 * ERROR HANDLING: VFS handle cleanup on allocation failure
 * - If allocHandle fails (EMFILE, process dead, etc.)
 * - Must close VFS handle to release resources
 * - Otherwise handle leaks in VFS until kernel restart
 * - Entity refcount not decremented, prevents deletion
 *
 * @param self - Kernel instance
 * @param proc - Calling process
 * @param path - VFS path to file
 * @param flags - Open flags (read, write, create, append, truncate, excl)
 * @returns File descriptor number
 * @throws ENOENT - File not found and create not set
 * @throws EPERM - Permission denied
 * @throws EISDIR - Path is directory but opened for writing
 * @throws ENOTDIR - Path component is not directory
 * @throws EEXIST - File exists and excl flag set
 * @throws EMFILE - Too many open handles
 */
export async function openFile(
    self: Kernel,
    proc: Process,
    path: string,
    flags: OpenFlags,
): Promise<number> {
    // Open file through VFS (ASYNC - process could die here)
    // Performs: path resolution, entity lookup, permission checks,
    // optional creation/truncation
    const vfsHandle = await self.vfs.open(path, flags, proc.user);

    // RACE FIX: Check process still running after await (TODO)
    // If process died while opening, close VFS handle and bail
    // (Currently not implemented - VFS handle leaks if process killed)

    // Wrap VFS handle in adapter for kernel Handle interface
    // Adapter ID reuses VFS handle ID (no new UUID needed)
    const adapter = new FileHandleAdapter(vfsHandle.id, vfsHandle);

    // Allocate fd and register in kernel table
    // If this fails, VFS handle stays open - BUG
    // TODO: Wrap in try/catch, close VFS handle on error
    return allocHandle(self, proc, adapter);
}
