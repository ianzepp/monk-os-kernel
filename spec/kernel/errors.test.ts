/**
 * Kernel Errors Tests
 */

import { describe, it, expect } from 'bun:test';
import {
    ENOSYS,
    ECHILD,
    ESRCH,
    EBADF,
    EINVAL,
    EPERM,
    ProcessExited,
} from '@src/kernel/errors.js';

describe('Kernel Errors', () => {
    describe('ENOSYS', () => {
        it('should have correct code', () => {
            const err = new ENOSYS('test_syscall');

            expect(err.code).toBe('ENOSYS');
            expect(err.message).toContain('test_syscall');
        });
    });

    describe('ECHILD', () => {
        it('should have correct code', () => {
            const err = new ECHILD('custom message');

            expect(err.code).toBe('ECHILD');
            expect(err.message).toBe('custom message');
        });

        it('should have default message', () => {
            const err = new ECHILD();

            expect(err.message).toBe('No child processes');
        });
    });

    describe('ESRCH', () => {
        it('should have correct code', () => {
            const err = new ESRCH('No such process: 42');

            expect(err.code).toBe('ESRCH');
            expect(err.message).toContain('42');
        });
    });

    describe('EBADF', () => {
        it('should have correct code', () => {
            const err = new EBADF('Bad file descriptor: 5');

            expect(err.code).toBe('EBADF');
            expect(err.message).toContain('5');
        });
    });

    describe('EINVAL', () => {
        it('should have correct code', () => {
            const err = new EINVAL('Invalid argument');

            expect(err.code).toBe('EINVAL');
        });
    });

    describe('EPERM', () => {
        it('should have correct code', () => {
            const err = new EPERM('Operation not permitted');

            expect(err.code).toBe('EPERM');
        });
    });

    describe('ProcessExited', () => {
        it('should store exit code', () => {
            const err = new ProcessExited(42);

            expect(err.code).toBe(42);
            expect(err.name).toBe('ProcessExited');
            expect(err.message).toContain('42');
        });

        it('should handle zero exit code', () => {
            const err = new ProcessExited(0);

            expect(err.code).toBe(0);
        });
    });
});
