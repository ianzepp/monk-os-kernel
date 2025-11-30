/**
 * HAL Error Types
 *
 * POSIX-style error codes for HAL operations.
 * Higher layers can catch specific error types and handle appropriately.
 */

/**
 * Base HAL error class.
 * All HAL errors extend this.
 */
export class HALError extends Error {
    /** POSIX-style error code */
    readonly code: string;

    /** Numeric errno equivalent */
    readonly errno: number;

    constructor(code: string, errno: number, message: string) {
        super(message);
        this.name = 'HALError';
        this.code = code;
        this.errno = errno;
    }
}

// ============================================================================
// File/Block I/O Errors
// ============================================================================

/** Permission denied */
export class EACCES extends HALError {
    constructor(message = 'Permission denied') {
        super('EACCES', 13, message);
        this.name = 'EACCES';
    }
}

/** Resource temporarily unavailable (try again) */
export class EAGAIN extends HALError {
    constructor(message = 'Resource temporarily unavailable') {
        super('EAGAIN', 11, message);
        this.name = 'EAGAIN';
    }
}

/** Bad file descriptor */
export class EBADF extends HALError {
    constructor(message = 'Bad file descriptor') {
        super('EBADF', 9, message);
        this.name = 'EBADF';
    }
}

/** Device or resource busy */
export class EBUSY extends HALError {
    constructor(message = 'Device or resource busy') {
        super('EBUSY', 16, message);
        this.name = 'EBUSY';
    }
}

/** File exists */
export class EEXIST extends HALError {
    constructor(message = 'File exists') {
        super('EEXIST', 17, message);
        this.name = 'EEXIST';
    }
}

/** Bad address / Invalid argument */
export class EFAULT extends HALError {
    constructor(message = 'Bad address') {
        super('EFAULT', 14, message);
        this.name = 'EFAULT';
    }
}

/** File too large */
export class EFBIG extends HALError {
    constructor(message = 'File too large') {
        super('EFBIG', 27, message);
        this.name = 'EFBIG';
    }
}

/** Invalid argument */
export class EINVAL extends HALError {
    constructor(message = 'Invalid argument') {
        super('EINVAL', 22, message);
        this.name = 'EINVAL';
    }
}

/** I/O error */
export class EIO extends HALError {
    constructor(message = 'I/O error') {
        super('EIO', 5, message);
        this.name = 'EIO';
    }
}

/** Is a directory */
export class EISDIR extends HALError {
    constructor(message = 'Is a directory') {
        super('EISDIR', 21, message);
        this.name = 'EISDIR';
    }
}

/** Too many open files */
export class EMFILE extends HALError {
    constructor(message = 'Too many open files') {
        super('EMFILE', 24, message);
        this.name = 'EMFILE';
    }
}

/** File name too long */
export class ENAMETOOLONG extends HALError {
    constructor(message = 'File name too long') {
        super('ENAMETOOLONG', 36, message);
        this.name = 'ENAMETOOLONG';
    }
}

/** No such file or directory */
export class ENOENT extends HALError {
    constructor(message = 'No such file or directory') {
        super('ENOENT', 2, message);
        this.name = 'ENOENT';
    }
}

/** No space left on device */
export class ENOSPC extends HALError {
    constructor(message = 'No space left on device') {
        super('ENOSPC', 28, message);
        this.name = 'ENOSPC';
    }
}

/** Not a directory */
export class ENOTDIR extends HALError {
    constructor(message = 'Not a directory') {
        super('ENOTDIR', 20, message);
        this.name = 'ENOTDIR';
    }
}

/** Directory not empty */
export class ENOTEMPTY extends HALError {
    constructor(message = 'Directory not empty') {
        super('ENOTEMPTY', 39, message);
        this.name = 'ENOTEMPTY';
    }
}

/** Operation not permitted */
export class EPERM extends HALError {
    constructor(message = 'Operation not permitted') {
        super('EPERM', 1, message);
        this.name = 'EPERM';
    }
}

/** Read-only file system */
export class EROFS extends HALError {
    constructor(message = 'Read-only file system') {
        super('EROFS', 30, message);
        this.name = 'EROFS';
    }
}

// ============================================================================
// Network Errors
// ============================================================================

/** Address already in use */
export class EADDRINUSE extends HALError {
    constructor(message = 'Address already in use') {
        super('EADDRINUSE', 98, message);
        this.name = 'EADDRINUSE';
    }
}

/** Address not available */
export class EADDRNOTAVAIL extends HALError {
    constructor(message = 'Address not available') {
        super('EADDRNOTAVAIL', 99, message);
        this.name = 'EADDRNOTAVAIL';
    }
}

/** Connection refused */
export class ECONNREFUSED extends HALError {
    constructor(message = 'Connection refused') {
        super('ECONNREFUSED', 111, message);
        this.name = 'ECONNREFUSED';
    }
}

/** Connection reset by peer */
export class ECONNRESET extends HALError {
    constructor(message = 'Connection reset by peer') {
        super('ECONNRESET', 104, message);
        this.name = 'ECONNRESET';
    }
}

/** Connection timed out */
export class ETIMEDOUT extends HALError {
    constructor(message = 'Connection timed out') {
        super('ETIMEDOUT', 110, message);
        this.name = 'ETIMEDOUT';
    }
}

/** Host unreachable */
export class EHOSTUNREACH extends HALError {
    constructor(message = 'Host unreachable') {
        super('EHOSTUNREACH', 113, message);
        this.name = 'EHOSTUNREACH';
    }
}

/** Network unreachable */
export class ENETUNREACH extends HALError {
    constructor(message = 'Network unreachable') {
        super('ENETUNREACH', 101, message);
        this.name = 'ENETUNREACH';
    }
}

/** Socket not connected */
export class ENOTCONN extends HALError {
    constructor(message = 'Socket not connected') {
        super('ENOTCONN', 107, message);
        this.name = 'ENOTCONN';
    }
}

/** Broken pipe */
export class EPIPE extends HALError {
    constructor(message = 'Broken pipe') {
        super('EPIPE', 32, message);
        this.name = 'EPIPE';
    }
}

// ============================================================================
// Process/IPC Errors
// ============================================================================

/** Operation canceled / aborted */
export class ECANCELED extends HALError {
    constructor(message = 'Operation canceled') {
        super('ECANCELED', 125, message);
        this.name = 'ECANCELED';
    }
}

/** Resource deadlock would occur */
export class EDEADLK extends HALError {
    constructor(message = 'Resource deadlock would occur') {
        super('EDEADLK', 35, message);
        this.name = 'EDEADLK';
    }
}

/** Interrupted system call */
export class EINTR extends HALError {
    constructor(message = 'Interrupted system call') {
        super('EINTR', 4, message);
        this.name = 'EINTR';
    }
}

/** No child processes */
export class ECHILD extends HALError {
    constructor(message = 'No child processes') {
        super('ECHILD', 10, message);
        this.name = 'ECHILD';
    }
}

/** No such process */
export class ESRCH extends HALError {
    constructor(message = 'No such process') {
        super('ESRCH', 3, message);
        this.name = 'ESRCH';
    }
}

// ============================================================================
// Crypto Errors
// ============================================================================

/** Authentication/verification failed */
export class EAUTH extends HALError {
    constructor(message = 'Authentication failed') {
        super('EAUTH', 80, message);
        this.name = 'EAUTH';
    }
}

// ============================================================================
// General Errors
// ============================================================================

/** Function not implemented */
export class ENOSYS extends HALError {
    constructor(message = 'Function not implemented') {
        super('ENOSYS', 38, message);
        this.name = 'ENOSYS';
    }
}

/** Operation not supported */
export class ENOTSUP extends HALError {
    constructor(message = 'Operation not supported') {
        super('ENOTSUP', 95, message);
        this.name = 'ENOTSUP';
    }
}

/** Value too large for defined data type */
export class EOVERFLOW extends HALError {
    constructor(message = 'Value too large') {
        super('EOVERFLOW', 75, message);
        this.name = 'EOVERFLOW';
    }
}

/** Result too large / out of range */
export class ERANGE extends HALError {
    constructor(message = 'Result too large') {
        super('ERANGE', 34, message);
        this.name = 'ERANGE';
    }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if an error is a HAL error
 */
export function isHALError(err: unknown): err is HALError {
    return err instanceof HALError;
}

/**
 * Check if an error has a specific code
 */
export function hasErrorCode(err: unknown, code: string): boolean {
    return isHALError(err) && err.code === code;
}

/**
 * Map common Bun/Node error codes to HAL errors
 */
export function fromSystemError(err: Error & { code?: string }): HALError {
    const code = err.code;
    const message = err.message;

    switch (code) {
        case 'EACCES':
            return new EACCES(message);
        case 'EAGAIN':
        case 'EWOULDBLOCK':
            return new EAGAIN(message);
        case 'EBADF':
            return new EBADF(message);
        case 'EBUSY':
            return new EBUSY(message);
        case 'EEXIST':
            return new EEXIST(message);
        case 'EINVAL':
            return new EINVAL(message);
        case 'EIO':
            return new EIO(message);
        case 'EISDIR':
            return new EISDIR(message);
        case 'EMFILE':
            return new EMFILE(message);
        case 'ENOENT':
            return new ENOENT(message);
        case 'ENOSPC':
            return new ENOSPC(message);
        case 'ENOTDIR':
            return new ENOTDIR(message);
        case 'ENOTEMPTY':
            return new ENOTEMPTY(message);
        case 'EPERM':
            return new EPERM(message);
        case 'EROFS':
            return new EROFS(message);
        case 'EADDRINUSE':
            return new EADDRINUSE(message);
        case 'ECONNREFUSED':
            return new ECONNREFUSED(message);
        case 'ECONNRESET':
            return new ECONNRESET(message);
        case 'ETIMEDOUT':
            return new ETIMEDOUT(message);
        case 'EPIPE':
            return new EPIPE(message);
        default:
            return new EIO(message || 'Unknown error');
    }
}
