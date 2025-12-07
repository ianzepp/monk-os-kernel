/**
 * Syscall Types - Shared type definitions for the syscall layer
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The syscall layer separates system call routing and implementation from the
 * kernel. This module defines the shared types used across all syscall domains
 * (VFS, EMS, HAL, process, handle, pool).
 *
 * DESIGN PRINCIPLES
 * =================
 * 1. **Direct dependencies**: Each syscall function receives exactly what it
 *    needs (kernel, vfs, ems, hal, proc) as parameters - no context objects.
 *
 * 2. **Yield errors, don't throw**: All syscalls return AsyncIterable<Response>.
 *    Validation errors are yielded, not thrown. This ensures consistent error
 *    handling across all syscall types.
 *
 * 3. **Explicit argument ordering**: Arguments follow a consistent order:
 *    proc, kernel, vfs/ems/hal, syscall-specific args
 *
 * Re-exports key types from kernel/types.ts and kernel/syscalls/types.ts for
 * convenience, so syscall implementations don't need multiple imports.
 *
 * @module syscall/types
 */

// Re-export Process type for syscall implementations
export type { Process, OpenFlags, SpawnOpts, ExitStatus, SeekWhence } from '@src/kernel/types.js';

// Re-export Response type and helpers
export type { Response, Message } from '@src/message.js';
export { respond } from '@src/message.js';

// Re-export limits
export { MAX_STREAM_ENTRIES, MAX_HANDLES, DEFAULT_CHUNK_SIZE } from '@src/kernel/types.js';

// Re-export ProcessPortMessage for HAL syscalls
export type { ProcessPortMessage } from '@src/kernel/syscalls/types.js';
