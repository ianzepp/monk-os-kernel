/**
 * Syscall error class for VFS operations.
 */

export class SyscallError extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = code;
    }
}
