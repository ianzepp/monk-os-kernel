/**
 * Kernel Errors
 *
 * Re-exports HAL errors and adds kernel-specific errors.
 */

// Re-export HAL errors used by kernel
export {
    ENOSYS,
    ECHILD,
    ESRCH,
    EBADF,
    EINVAL,
    EPERM,
} from '@src/hal/index.js';

/**
 * Process exited (internal, not a real error)
 */
export class ProcessExited extends Error {
    readonly code: number;

    constructor(code: number) {
        super(`Process exited with code ${code}`);
        this.name = 'ProcessExited';
        this.code = code;
    }
}
