/**
 * HAL Error Types - POSIX-style error codes
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines a hierarchy of error types mirroring POSIX errno codes.
 * All HAL operations that can fail throw typed errors from this module, enabling
 * higher layers (VFS, kernel, process library) to handle specific error cases
 * without string parsing.
 *
 * The error hierarchy is intentionally flat - all errors extend HALError directly
 * rather than using sub-hierarchies. This simplifies error handling: code can
 * catch specific error types (ENOENT, EBADF, etc.) or catch HALError for any
 * HAL error.
 *
 * Each error class carries three pieces of information:
 * 1. code: POSIX error code string (e.g., 'ENOENT')
 * 2. errno: Numeric errno value for compatibility with C libraries
 * 3. message: Human-readable description (customizable per throw site)
 *
 * The module also provides helper functions for error detection (isHALError,
 * hasErrorCode) and mapping system errors (fromSystemError) to enable seamless
 * integration with Bun/Node error conventions.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Every HAL error has non-empty code, errno >= 0, and message
 * INV-2: Error codes match POSIX standards (errno.h numeric values)
 * INV-3: Error class name matches error code (e.g., ENOENT class for 'ENOENT' code)
 * INV-4: fromSystemError never throws - always returns a HAL error (defaulting to EIO)
 * INV-5: isHALError and hasErrorCode never throw - safe for any input
 *
 * CONCURRENCY MODEL
 * =================
 * Error classes are stateless - they only carry data, no shared mutable state.
 * Creating and throwing errors is thread-safe in JavaScript's single-threaded
 * async model. Multiple processes can throw errors concurrently without risk
 * of corruption.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * N/A - Error classes have no state and no async operations. No race conditions.
 *
 * MEMORY MANAGEMENT
 * =================
 * - Error instances are short-lived (thrown, caught, logged, discarded)
 * - No resources to clean up (just data fields)
 * - Error messages should be kept reasonably short to avoid memory bloat in logs
 *
 * ERROR HANDLING PATTERNS
 * =======================
 * Throughout Monk OS, errors follow these patterns:
 *
 * 1. HAL throws typed errors: `throw new ENOENT('/path/to/file')`
 * 2. VFS/kernel catch and re-throw: `catch (err) { if (err instanceof ENOENT) { ... } }`
 * 3. Kernel converts to Response: `{ op: 'error', data: { code: err.code, message: err.message } }`
 * 4. Process library throws SyscallError: `throw new SyscallError(response.data.code, response.data.message)`
 * 5. Application handles: `catch (err) { if (err.code === 'ENOENT') { ... } }`
 *
 * TESTABILITY
 * ===========
 * Error classes are trivial to test:
 * - Construct with message, verify code/errno/message fields
 * - Verify instanceof HALError and specific error class
 * - Test helper functions with various inputs (errors, non-errors, nullish values)
 * - Test fromSystemError with various Bun/Node error codes
 *
 * @module hal/errors
 */

// =============================================================================
// BASE ERROR CLASS
// =============================================================================

/**
 * Base HAL error class
 *
 * All HAL errors extend this class. Provides uniform structure with POSIX code,
 * numeric errno, and human-readable message.
 *
 * WHY: Typed errors enable precise error handling without string parsing.
 * Catching HALError catches all HAL errors; catching specific subclass catches
 * only that error type.
 *
 * INVARIANTS:
 * - code is non-empty string
 * - errno is non-negative integer
 * - message is non-empty string
 * - name is set to 'HALError' (overridden by subclasses)
 */
export class HALError extends Error {
    /**
     * POSIX-style error code
     *
     * WHY: Standard error codes enable cross-platform error handling. Code
     * like 'ENOENT' is recognized across UNIX systems, Bun, Node, etc.
     *
     * INVARIANT: Never changes after construction.
     */
    readonly code: string;

    /**
     * Numeric errno equivalent
     *
     * WHY: Some C libraries and system calls use numeric errno values.
     * Providing both string code and numeric errno enables compatibility.
     *
     * INVARIANT: Never changes after construction.
     */
    readonly errno: number;

    constructor(code: string, errno: number, message: string) {
        super(message);
        this.name = 'HALError';
        this.code = code;
        this.errno = errno;
    }
}

// =============================================================================
// FILE/BLOCK I/O ERRORS
// =============================================================================
// Errors related to file operations, block device access, filesystem state.

/**
 * Permission denied
 *
 * WHY: Operation requires permissions the caller doesn't have. Different from
 * EPERM (superuser required) - EACCES means file permissions deny access.
 *
 * USAGE: File read/write when mode doesn't permit, directory access denied.
 */
export class EACCES extends HALError {
    constructor(message = 'Permission denied') {
        super('EACCES', 13, message);
        this.name = 'EACCES';
    }
}

/**
 * Resource temporarily unavailable (try again)
 *
 * WHY: Non-blocking operation would block. Common with non-blocking I/O,
 * lock acquisition, semaphore wait with timeout.
 *
 * USAGE: Would block on read/write, lock already held, resource exhausted.
 */
export class EAGAIN extends HALError {
    constructor(message = 'Resource temporarily unavailable') {
        super('EAGAIN', 11, message);
        this.name = 'EAGAIN';
    }
}

/**
 * Bad file descriptor
 *
 * WHY: File descriptor is not valid. Either never opened, already closed,
 * or refers to wrong type (e.g., read on write-only fd).
 *
 * USAGE: Operation on closed handle, invalid fd number, type mismatch.
 */
export class EBADF extends HALError {
    constructor(message = 'Bad file descriptor') {
        super('EBADF', 9, message);
        this.name = 'EBADF';
    }
}

/**
 * Device or resource busy
 *
 * WHY: Resource is in use and cannot be accessed right now. Different from
 * EAGAIN (temporary) - EBUSY means resource is locked/mounted/in-use.
 *
 * USAGE: Cannot unmount busy filesystem, device in use, file locked.
 */
export class EBUSY extends HALError {
    constructor(message = 'Device or resource busy') {
        super('EBUSY', 16, message);
        this.name = 'EBUSY';
    }
}

/**
 * File exists
 *
 * WHY: Attempted to create file/directory that already exists when exclusive
 * creation was requested (O_EXCL flag).
 *
 * USAGE: create() with { exclusive: true } on existing path.
 */
export class EEXIST extends HALError {
    constructor(message = 'File exists') {
        super('EEXIST', 17, message);
        this.name = 'EEXIST';
    }
}

/**
 * Bad address / Invalid argument
 *
 * WHY: Pointer or buffer address is invalid. In JavaScript context, typically
 * means null/undefined where value required, or buffer out of bounds.
 *
 * USAGE: Null buffer, offset beyond bounds, invalid memory region.
 */
export class EFAULT extends HALError {
    constructor(message = 'Bad address') {
        super('EFAULT', 14, message);
        this.name = 'EFAULT';
    }
}

/**
 * File too large
 *
 * WHY: File size exceeds system limits or requested operation would grow
 * file beyond supported size.
 *
 * USAGE: Write would exceed max file size, seek beyond max offset.
 */
export class EFBIG extends HALError {
    constructor(message = 'File too large') {
        super('EFBIG', 27, message);
        this.name = 'EFBIG';
    }
}

/**
 * Invalid argument
 *
 * WHY: Argument to function is invalid. Different from EFAULT (bad address) -
 * EINVAL means value is semantically wrong (negative size, invalid flag, etc.).
 *
 * USAGE: Invalid flag combination, negative length, unknown operation.
 */
export class EINVAL extends HALError {
    constructor(message = 'Invalid argument') {
        super('EINVAL', 22, message);
        this.name = 'EINVAL';
    }
}

/**
 * I/O error
 *
 * WHY: Physical I/O error occurred. Disk read failed, network hardware error,
 * device malfunction. Typically unrecoverable.
 *
 * USAGE: Disk failure, hardware error, corrupted data.
 */
export class EIO extends HALError {
    constructor(message = 'I/O error') {
        super('EIO', 5, message);
        this.name = 'EIO';
    }
}

/**
 * Is a directory
 *
 * WHY: Attempted file operation on a directory. Cannot read/write directory
 * as file, cannot open directory with O_WRONLY.
 *
 * USAGE: Tried to open() directory for writing, unlink() directory.
 */
export class EISDIR extends HALError {
    constructor(message = 'Is a directory') {
        super('EISDIR', 21, message);
        this.name = 'EISDIR';
    }
}

/**
 * Too many open files
 *
 * WHY: Process exceeded limit on open file descriptors. Cannot open more
 * files until some are closed.
 *
 * USAGE: open() when at fd limit (typically 256 in Monk OS).
 */
export class EMFILE extends HALError {
    constructor(message = 'Too many open files') {
        super('EMFILE', 24, message);
        this.name = 'EMFILE';
    }
}

/**
 * File name too long
 *
 * WHY: Path component or full path exceeds system limits. POSIX defines
 * NAME_MAX (component) and PATH_MAX (full path).
 *
 * USAGE: Path longer than supported, component name exceeds limit.
 */
export class ENAMETOOLONG extends HALError {
    constructor(message = 'File name too long') {
        super('ENAMETOOLONG', 36, message);
        this.name = 'ENAMETOOLONG';
    }
}

/**
 * No such file or directory
 *
 * WHY: Most common filesystem error. Path does not exist in VFS or parent
 * directory doesn't exist.
 *
 * USAGE: open() non-existent file, stat() missing path, readdir() on missing dir.
 */
export class ENOENT extends HALError {
    constructor(message = 'No such file or directory') {
        super('ENOENT', 2, message);
        this.name = 'ENOENT';
    }
}

/**
 * No space left on device
 *
 * WHY: Storage device is full. Cannot write more data, cannot create new files.
 *
 * USAGE: write() when disk full, create() when no inodes left.
 */
export class ENOSPC extends HALError {
    constructor(message = 'No space left on device') {
        super('ENOSPC', 28, message);
        this.name = 'ENOSPC';
    }
}

/**
 * Not a directory
 *
 * WHY: Path component is not a directory when directory was expected. Cannot
 * traverse through file as if it were directory.
 *
 * USAGE: Path like /file/subdir where 'file' is not a directory.
 */
export class ENOTDIR extends HALError {
    constructor(message = 'Not a directory') {
        super('ENOTDIR', 20, message);
        this.name = 'ENOTDIR';
    }
}

/**
 * Directory not empty
 *
 * WHY: Attempted to remove directory that still contains files. rmdir()
 * requires empty directory.
 *
 * USAGE: unlink() on non-empty directory.
 */
export class ENOTEMPTY extends HALError {
    constructor(message = 'Directory not empty') {
        super('ENOTEMPTY', 39, message);
        this.name = 'ENOTEMPTY';
    }
}

/**
 * Operation not permitted
 *
 * WHY: Operation requires superuser/root privileges. Different from EACCES
 * (file permissions) - EPERM means only root can do this.
 *
 * USAGE: chown() without privilege, mount/unmount as non-root.
 */
export class EPERM extends HALError {
    constructor(message = 'Operation not permitted') {
        super('EPERM', 1, message);
        this.name = 'EPERM';
    }
}

/**
 * Read-only file system
 *
 * WHY: Attempted write operation on read-only filesystem. Mount was read-only
 * or device is write-protected.
 *
 * USAGE: write() on read-only mount, unlink() on read-only filesystem.
 */
export class EROFS extends HALError {
    constructor(message = 'Read-only file system') {
        super('EROFS', 30, message);
        this.name = 'EROFS';
    }
}

// =============================================================================
// NETWORK ERRORS
// =============================================================================
// Errors related to network operations, sockets, TCP/UDP communication.

/**
 * Address already in use
 *
 * WHY: Attempted to bind socket to address:port that is already bound by
 * another socket. Common when restarting server quickly (TIME_WAIT state).
 *
 * USAGE: listen() on already-bound port.
 */
export class EADDRINUSE extends HALError {
    constructor(message = 'Address already in use') {
        super('EADDRINUSE', 98, message);
        this.name = 'EADDRINUSE';
    }
}

/**
 * Address not available
 *
 * WHY: Requested address cannot be assigned. Interface doesn't exist, address
 * not local, or address family not supported.
 *
 * USAGE: bind() to non-local address, connect() from invalid source.
 */
export class EADDRNOTAVAIL extends HALError {
    constructor(message = 'Address not available') {
        super('EADDRNOTAVAIL', 99, message);
        this.name = 'EADDRNOTAVAIL';
    }
}

/**
 * Connection refused
 *
 * WHY: Remote host actively refused connection. Port is closed, no server
 * listening, or firewall blocking.
 *
 * USAGE: connect() to closed port, server not running.
 */
export class ECONNREFUSED extends HALError {
    constructor(message = 'Connection refused') {
        super('ECONNREFUSED', 111, message);
        this.name = 'ECONNREFUSED';
    }
}

/**
 * Connection reset by peer
 *
 * WHY: Remote end forcibly closed connection (sent RST packet). Different from
 * graceful close (FIN packet).
 *
 * USAGE: read() after peer crashed, write() after peer sent RST.
 */
export class ECONNRESET extends HALError {
    constructor(message = 'Connection reset by peer') {
        super('ECONNRESET', 104, message);
        this.name = 'ECONNRESET';
    }
}

/**
 * Connection timed out
 *
 * WHY: Connection attempt or data transfer timed out. No response from remote
 * end within timeout period.
 *
 * USAGE: connect() timeout, read/write timeout, keepalive failure.
 */
export class ETIMEDOUT extends HALError {
    constructor(message = 'Connection timed out') {
        super('ETIMEDOUT', 110, message);
        this.name = 'ETIMEDOUT';
    }
}

/**
 * Host unreachable
 *
 * WHY: No route to destination host. Network interface down, routing table
 * missing route, host not on network.
 *
 * USAGE: connect() when host not reachable via any route.
 */
export class EHOSTUNREACH extends HALError {
    constructor(message = 'Host unreachable') {
        super('EHOSTUNREACH', 113, message);
        this.name = 'EHOSTUNREACH';
    }
}

/**
 * Network unreachable
 *
 * WHY: Network is unreachable. Interface down, no default route, network
 * disconnected.
 *
 * USAGE: connect() when network is down or disconnected.
 */
export class ENETUNREACH extends HALError {
    constructor(message = 'Network unreachable') {
        super('ENETUNREACH', 101, message);
        this.name = 'ENETUNREACH';
    }
}

/**
 * Socket not connected
 *
 * WHY: Operation requires connected socket but socket is not connected.
 * Common with stream sockets (TCP).
 *
 * USAGE: send() on unconnected TCP socket, getpeername() on unconnected socket.
 */
export class ENOTCONN extends HALError {
    constructor(message = 'Socket not connected') {
        super('ENOTCONN', 107, message);
        this.name = 'ENOTCONN';
    }
}

/**
 * Broken pipe
 *
 * WHY: Write to pipe/socket with no reader. Reading end closed or process
 * terminated. Typically triggers SIGPIPE signal in UNIX.
 *
 * USAGE: write() after reader closed, send() after remote close.
 */
export class EPIPE extends HALError {
    constructor(message = 'Broken pipe') {
        super('EPIPE', 32, message);
        this.name = 'EPIPE';
    }
}

// =============================================================================
// PROCESS/IPC ERRORS
// =============================================================================
// Errors related to process management, inter-process communication, signals.

/**
 * Operation canceled / aborted
 *
 * WHY: Async operation was explicitly cancelled by caller via AbortSignal
 * or similar mechanism.
 *
 * USAGE: fetch() aborted, sleep() cancelled, worker terminated mid-operation.
 */
export class ECANCELED extends HALError {
    constructor(message = 'Operation canceled') {
        super('ECANCELED', 125, message);
        this.name = 'ECANCELED';
    }
}

/**
 * Resource deadlock would occur
 *
 * WHY: Acquiring lock would cause deadlock. Detected by lock manager or
 * detected algorithmically.
 *
 * USAGE: Mutex acquisition would deadlock, circular lock dependency.
 */
export class EDEADLK extends HALError {
    constructor(message = 'Resource deadlock would occur') {
        super('EDEADLK', 35, message);
        this.name = 'EDEADLK';
    }
}

/**
 * Interrupted system call
 *
 * WHY: Blocking call was interrupted by signal delivery. Common in UNIX where
 * signals interrupt system calls.
 *
 * USAGE: read() interrupted by SIGINT, sleep() interrupted by SIGTERM.
 */
export class EINTR extends HALError {
    constructor(message = 'Interrupted system call') {
        super('EINTR', 4, message);
        this.name = 'EINTR';
    }
}

/**
 * No child processes
 *
 * WHY: wait() called but process has no children. All children already reaped
 * or no children ever spawned.
 *
 * USAGE: wait() when no child processes exist.
 */
export class ECHILD extends HALError {
    constructor(message = 'No child processes') {
        super('ECHILD', 10, message);
        this.name = 'ECHILD';
    }
}

/**
 * No such process
 *
 * WHY: Referenced process does not exist. Already exited, never existed, or
 * wrong namespace.
 *
 * USAGE: kill() with invalid PID, wait() on non-existent process.
 */
export class ESRCH extends HALError {
    constructor(message = 'No such process') {
        super('ESRCH', 3, message);
        this.name = 'ESRCH';
    }
}

// =============================================================================
// CRYPTO ERRORS
// =============================================================================
// Errors related to cryptographic operations, authentication, verification.

/**
 * Authentication/verification failed
 *
 * WHY: Cryptographic verification failed. Signature invalid, MAC mismatch,
 * wrong password, expired certificate.
 *
 * USAGE: verify() failed, decrypt() with wrong key, authenticate() rejected.
 */
export class EAUTH extends HALError {
    constructor(message = 'Authentication failed') {
        super('EAUTH', 80, message);
        this.name = 'EAUTH';
    }
}

// =============================================================================
// GENERAL ERRORS
// =============================================================================
// Errors that don't fit specific categories.

/**
 * Function not implemented
 *
 * WHY: Function is defined but not yet implemented. Placeholder for future
 * functionality or platform-specific feature not available.
 *
 * USAGE: Unimplemented syscall, feature not available on this platform.
 */
export class ENOSYS extends HALError {
    constructor(message = 'Function not implemented') {
        super('ENOSYS', 38, message);
        this.name = 'ENOSYS';
    }
}

/**
 * Operation not supported
 *
 * WHY: Operation is not supported on this object/device/platform. Different
 * from ENOSYS (not implemented) - ENOTSUP means fundamentally incompatible.
 *
 * USAGE: seek() on pipe, write() on read-only handle, mmap() on network socket.
 */
export class ENOTSUP extends HALError {
    constructor(message = 'Operation not supported') {
        super('ENOTSUP', 95, message);
        this.name = 'ENOTSUP';
    }
}

/**
 * Value too large for defined data type
 *
 * WHY: Value exceeds maximum size for data type. File too large for 32-bit
 * offset, number too large for integer type.
 *
 * USAGE: seek() beyond max offset, size larger than size_t.
 */
export class EOVERFLOW extends HALError {
    constructor(message = 'Value too large') {
        super('EOVERFLOW', 75, message);
        this.name = 'EOVERFLOW';
    }
}

/**
 * Result too large / out of range
 *
 * WHY: Mathematical result cannot be represented. Overflow in calculation,
 * result outside valid range.
 *
 * USAGE: Math operation overflow, conversion out of range.
 */
export class ERANGE extends HALError {
    constructor(message = 'Result too large') {
        super('ERANGE', 34, message);
        this.name = 'ERANGE';
    }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if an error is a HAL error
 *
 * WHY: Type guard enables TypeScript to narrow error type in catch blocks.
 * Allows accessing code/errno properties safely.
 *
 * ALGORITHM:
 * 1. Check if err is instance of HALError
 * 2. Return boolean (TypeScript narrows type if true)
 *
 * TESTABILITY: Works with any input - never throws.
 *
 * @param err - Unknown error value
 * @returns True if err is HALError instance
 */
export function isHALError(err: unknown): err is HALError {
    return err instanceof HALError;
}

/**
 * Check if an error has a specific code
 *
 * WHY: Convenience helper for error code checking. Combines instanceof and
 * code comparison in single call.
 *
 * ALGORITHM:
 * 1. Check if err is HALError via isHALError()
 * 2. If yes, compare err.code to code parameter
 * 3. Return boolean
 *
 * TESTABILITY: Works with any input - never throws.
 *
 * @param err - Unknown error value
 * @param code - Error code to check for
 * @returns True if err is HAL error with matching code
 */
export function hasErrorCode(err: unknown, code: string): boolean {
    return isHALError(err) && err.code === code;
}

/**
 * Map common Bun/Node error codes to HAL errors
 *
 * Converts system errors (from Bun.spawn, fs operations, network calls) to
 * appropriate HAL error instances. Preserves original error message.
 *
 * ALGORITHM:
 * 1. Extract err.code string (if present)
 * 2. Switch on code, return matching HAL error class
 * 3. Default to EIO for unknown codes
 *
 * WHY: Bun/Node throw errors with code property (e.g., { code: 'ENOENT' }).
 * We need to convert these to typed HAL errors for consistent handling.
 *
 * INVARIANT: Never throws - always returns a HAL error instance. Unknown codes
 * map to EIO (generic I/O error).
 *
 * TESTABILITY: Can verify all known codes map correctly, unknown codes default to EIO.
 *
 * @param err - System error with code property
 * @returns Corresponding HAL error instance
 */
export function fromSystemError(err: Error & { code?: string }): HALError {
    const code = err.code;
    const message = err.message;

    switch (code) {
        case 'EACCES':
            return new EACCES(message);
        case 'EAGAIN':
        case 'EWOULDBLOCK': // WHY: EWOULDBLOCK is alias for EAGAIN on many systems
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
            // WHY: Unknown error codes map to generic I/O error. Preserves
            // original message for debugging.
            return new EIO(message || 'Unknown error');
    }
}

/**
 * Create a HAL error from a code string and message
 *
 * WHY: Useful when reconstructing errors from serialized data (e.g., responses
 * from kernel, IPC messages) where only the code string and message are available.
 *
 * ALGORITHM:
 * 1. Delegate to fromSystemError with a synthetic error object
 * 2. Return the matching HAL error instance
 *
 * INVARIANT: Never throws - always returns a HAL error instance. Unknown codes
 * map to EIO (generic I/O error).
 *
 * @param code - Error code string (e.g., 'ENOENT', 'EINVAL')
 * @param message - Human-readable error message
 * @returns Corresponding HAL error instance
 */
export function fromCode(code: string, message: string): HALError {
    return fromSystemError({ code, message, name: code } as Error & { code: string });
}
