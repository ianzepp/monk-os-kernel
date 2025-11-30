/**
 * Process Library Errors
 *
 * Reconstructs typed HAL errors from kernel wire format.
 * When the kernel returns { error: { code: 'ENOENT', message: '...' } },
 * this module reconstructs the appropriate typed error class.
 */

// Re-export HAL errors for use by process code
export {
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
    isHALError,
    hasErrorCode,
} from '@src/hal/errors.js';

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

/**
 * Error constructor type
 */
type ErrorConstructor = new (message: string) => HALError;

/**
 * Map of error codes to constructors
 */
const errorConstructors: Record<string, ErrorConstructor> = {
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
};

/**
 * Reconstruct a typed error from wire format.
 *
 * @param error - Error with code property from kernel
 * @returns Typed HAL error
 */
export function reconstructError(error: Error & { code?: string }): Error {
    const code = error.code;
    if (!code) {
        return error;
    }

    const Constructor = errorConstructors[code];
    if (Constructor) {
        return new Constructor(error.message);
    }

    // Unknown code - return as-is with code attached
    return error;
}

/**
 * Wrap a syscall promise to reconstruct errors.
 *
 * @param promise - Syscall promise
 * @returns Promise that rejects with typed errors
 */
export async function withTypedErrors<T>(promise: Promise<T>): Promise<T> {
    try {
        return await promise;
    } catch (error) {
        throw reconstructError(error as Error & { code?: string });
    }
}
