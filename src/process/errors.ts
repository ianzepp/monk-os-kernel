/**
 * Process Library Errors - Typed error reconstruction from wire format
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * When syscalls fail, the kernel returns error information in wire format:
 * { error: { code: 'ENOENT', message: 'No such file' } }. This module
 * reconstructs the appropriate typed HAL error class from that wire format.
 *
 * WHY RECONSTRUCTION IS NEEDED
 * ============================
 * JavaScript's structured clone algorithm (used by postMessage) cannot
 * transfer class instances with their prototype chain intact. Error classes
 * become plain objects. This module recreates proper error instances so
 * userland code can use instanceof checks and typed catch blocks.
 *
 * ERROR FLOW
 * ==========
 *
 *   Kernel                          Wire                         Process
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │                                                                     │
 *   │  throw new ENOENT('...')  ──>  { code, message }  ──>  new ENOENT() │
 *   │        (class)                    (plain obj)           (class)    │
 *   │                                                                     │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Reconstructed error has same code property as wire format
 * INV-2: Reconstructed error has same message as wire format
 * INV-3: Unknown error codes pass through as-is
 * INV-4: Errors without code property pass through unchanged
 *
 * CONCURRENCY MODEL
 * =================
 * Error reconstruction is pure function with no shared state.
 * Safe to call from multiple concurrent syscalls.
 *
 * MEMORY MANAGEMENT
 * =================
 * - Error constructors map is static (no per-call allocation)
 * - Reconstructed errors are new instances (normal GC)
 *
 * @module process/errors
 */

// =============================================================================
// RE-EXPORTS
// =============================================================================

/**
 * Re-export HAL error classes for use by process code.
 *
 * WHY re-export: Allows userland code to import error classes from
 * '@src/process' instead of reaching into '@src/hal'. Single import point.
 */
export {
    // Base class
    HALError,

    // File system errors
    EACCES,
    EBADF,
    EBUSY,
    EEXIST,
    EFBIG,
    EISDIR,
    ENAMETOOLONG,
    ENOENT,
    ENOSPC,
    ENOTDIR,
    ENOTEMPTY,
    EROFS,

    // Permission errors
    EPERM,

    // Resource errors
    EAGAIN,
    EMFILE,

    // I/O errors
    EIO,
    EFAULT,
    EINVAL,

    // Network errors
    EADDRINUSE,
    EADDRNOTAVAIL,
    ECONNREFUSED,
    ECONNRESET,
    ETIMEDOUT,
    EHOSTUNREACH,
    ENETUNREACH,
    ENOTCONN,
    EPIPE,

    // Process/signal errors
    ECANCELED,
    EDEADLK,
    EINTR,
    ECHILD,
    ESRCH,

    // Auth/capability errors
    EAUTH,

    // System errors
    ENOSYS,
    ENOTSUP,
    EOVERFLOW,
    ERANGE,

    // Type guards
    isHALError,
    hasErrorCode,
} from '@src/hal/errors.js';

// =============================================================================
// IMPORTS (for local use)
// =============================================================================

import {
    HALError,
    EACCES,
    EAGAIN,
    EBADF,
    EBUSY,
    EEXIST,
    EFAULT,
    EFBIG,
    EINVAL,
    EIO,
    EISDIR,
    EMFILE,
    ENAMETOOLONG,
    ENOENT,
    ENOSPC,
    ENOTDIR,
    ENOTEMPTY,
    EPERM,
    EROFS,
    EADDRINUSE,
    EADDRNOTAVAIL,
    ECONNREFUSED,
    ECONNRESET,
    ETIMEDOUT,
    EHOSTUNREACH,
    ENETUNREACH,
    ENOTCONN,
    EPIPE,
    ECANCELED,
    EDEADLK,
    EINTR,
    ECHILD,
    ESRCH,
    EAUTH,
    ENOSYS,
    ENOTSUP,
    EOVERFLOW,
    ERANGE,
} from '@src/hal/errors.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Error constructor signature.
 *
 * All HAL errors take a message string and return a HALError subclass.
 */
type ErrorConstructor = new (message: string) => HALError;

// =============================================================================
// ERROR CONSTRUCTOR MAP
// =============================================================================

/**
 * Map of error codes to their constructors.
 *
 * WHY Map object: O(1) lookup by code string. Faster than switch statement
 * for large number of error types.
 *
 * MAINTENANCE: When adding new error types to HAL, add them here too.
 */
const errorConstructors: Record<string, ErrorConstructor> = {
    // File system errors
    EACCES,
    EBADF,
    EBUSY,
    EEXIST,
    EFBIG,
    EISDIR,
    ENAMETOOLONG,
    ENOENT,
    ENOSPC,
    ENOTDIR,
    ENOTEMPTY,
    EROFS,

    // Permission errors
    EPERM,

    // Resource errors
    EAGAIN,
    EMFILE,

    // I/O errors
    EIO,
    EFAULT,
    EINVAL,

    // Network errors
    EADDRINUSE,
    EADDRNOTAVAIL,
    ECONNREFUSED,
    ECONNRESET,
    ETIMEDOUT,
    EHOSTUNREACH,
    ENETUNREACH,
    ENOTCONN,
    EPIPE,

    // Process/signal errors
    ECANCELED,
    EDEADLK,
    EINTR,
    ECHILD,
    ESRCH,

    // Auth/capability errors
    EAUTH,

    // System errors
    ENOSYS,
    ENOTSUP,
    EOVERFLOW,
    ERANGE,
};

// =============================================================================
// ERROR RECONSTRUCTION
// =============================================================================

/**
 * Reconstruct a typed error from wire format.
 *
 * ALGORITHM:
 * 1. Check if error has a code property
 * 2. If no code, return as-is (INV-4)
 * 3. Look up constructor for code
 * 4. If found, create new instance with message
 * 5. If not found, return as-is with code attached (INV-3)
 *
 * @param error - Error object with optional code property from kernel
 * @returns Typed HAL error if code is known, original error otherwise
 *
 * @example
 * // Kernel returns: { code: 'ENOENT', message: 'No such file' }
 * const typed = reconstructError(err);
 * // typed instanceof ENOENT === true
 */
export function reconstructError(error: Error & { code?: string }): Error {
    const code = error.code;

    // INV-4: No code means not a HAL error, pass through
    if (!code) {
        return error;
    }

    const Constructor = errorConstructors[code];

    if (Constructor) {
        // Create properly typed error instance
        return new Constructor(error.message);
    }

    // INV-3: Unknown code - return as-is with code attached
    // This preserves future compatibility when new error codes are added
    return error;
}

/**
 * Wrap a syscall promise to reconstruct errors.
 *
 * This is the primary integration point between syscall transport and
 * error reconstruction. All syscall wrappers in the process library
 * use this to ensure errors are properly typed.
 *
 * ALGORITHM:
 * 1. Await the promise
 * 2. If success, return result
 * 3. If error, reconstruct and re-throw
 *
 * @param promise - Syscall promise from transport layer
 * @returns Promise that rejects with typed errors
 *
 * @example
 * export function open(path: string, flags?: OpenFlags): Promise<number> {
 *     return withTypedErrors(syscall<number>('open', path, flags));
 * }
 */
export async function withTypedErrors<T>(promise: Promise<T>): Promise<T> {
    try {
        return await promise;
    } catch (error) {
        throw reconstructError(error as Error & { code?: string });
    }
}
