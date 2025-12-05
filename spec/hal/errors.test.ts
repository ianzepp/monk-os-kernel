import { describe, it, expect } from 'bun:test';
import {
    HALError,
    EACCES,
    EAGAIN,
    EBADF,
    EBUSY,
    EEXIST,
    EINVAL,
    EIO,
    EISDIR,
    ENOENT,
    ENOSPC,
    ENOTDIR,
    ENOTEMPTY,
    EPERM,
    ECONNREFUSED,
    ECONNRESET,
    ETIMEDOUT,
    isHALError,
    hasErrorCode,
    fromSystemError,
} from '@src/hal/index.js';

describe('HAL Errors', () => {
    describe('HALError base class', () => {
        it('should have correct code and errno', () => {
            const err = new HALError('TEST', 99, 'test message');

            expect(err.code).toBe('TEST');
            expect(err.errno).toBe(99);
            expect(err.message).toBe('test message');
            expect(err.name).toBe('HALError');
        });

        it('should be instanceof Error', () => {
            const err = new HALError('TEST', 99, 'test');

            expect(err).toBeInstanceOf(Error);
            expect(err).toBeInstanceOf(HALError);
        });
    });

    describe('specific error classes', () => {
        it('EACCES should have correct code 13', () => {
            const err = new EACCES();

            expect(err.code).toBe('EACCES');
            expect(err.errno).toBe(13);
            expect(err.name).toBe('EACCES');
            expect(err.message).toBe('Permission denied');
        });

        it('EACCES should accept custom message', () => {
            const err = new EACCES('Cannot access /etc/passwd');

            expect(err.message).toBe('Cannot access /etc/passwd');
        });

        it('EAGAIN should have correct code 11', () => {
            const err = new EAGAIN();

            expect(err.code).toBe('EAGAIN');
            expect(err.errno).toBe(11);
        });

        it('EBADF should have correct code 9', () => {
            const err = new EBADF();

            expect(err.code).toBe('EBADF');
            expect(err.errno).toBe(9);
        });

        it('EBUSY should have correct code 16', () => {
            const err = new EBUSY();

            expect(err.code).toBe('EBUSY');
            expect(err.errno).toBe(16);
        });

        it('EEXIST should have correct code 17', () => {
            const err = new EEXIST();

            expect(err.code).toBe('EEXIST');
            expect(err.errno).toBe(17);
        });

        it('EINVAL should have correct code 22', () => {
            const err = new EINVAL();

            expect(err.code).toBe('EINVAL');
            expect(err.errno).toBe(22);
        });

        it('EIO should have correct code 5', () => {
            const err = new EIO();

            expect(err.code).toBe('EIO');
            expect(err.errno).toBe(5);
        });

        it('EISDIR should have correct code 21', () => {
            const err = new EISDIR();

            expect(err.code).toBe('EISDIR');
            expect(err.errno).toBe(21);
        });

        it('ENOENT should have correct code 2', () => {
            const err = new ENOENT();

            expect(err.code).toBe('ENOENT');
            expect(err.errno).toBe(2);
        });

        it('ENOSPC should have correct code 28', () => {
            const err = new ENOSPC();

            expect(err.code).toBe('ENOSPC');
            expect(err.errno).toBe(28);
        });

        it('ENOTDIR should have correct code 20', () => {
            const err = new ENOTDIR();

            expect(err.code).toBe('ENOTDIR');
            expect(err.errno).toBe(20);
        });

        it('ENOTEMPTY should have correct code 39', () => {
            const err = new ENOTEMPTY();

            expect(err.code).toBe('ENOTEMPTY');
            expect(err.errno).toBe(39);
        });

        it('EPERM should have correct code 1', () => {
            const err = new EPERM();

            expect(err.code).toBe('EPERM');
            expect(err.errno).toBe(1);
        });

        it('ECONNREFUSED should have correct code 111', () => {
            const err = new ECONNREFUSED();

            expect(err.code).toBe('ECONNREFUSED');
            expect(err.errno).toBe(111);
        });

        it('ECONNRESET should have correct code 104', () => {
            const err = new ECONNRESET();

            expect(err.code).toBe('ECONNRESET');
            expect(err.errno).toBe(104);
        });

        it('ETIMEDOUT should have correct code 110', () => {
            const err = new ETIMEDOUT();

            expect(err.code).toBe('ETIMEDOUT');
            expect(err.errno).toBe(110);
        });
    });

    describe('isHALError', () => {
        it('should return true for HALError instances', () => {
            expect(isHALError(new HALError('TEST', 1, 'test'))).toBe(true);
            expect(isHALError(new ENOENT())).toBe(true);
            expect(isHALError(new EACCES())).toBe(true);
        });

        it('should return false for non-HALError values', () => {
            expect(isHALError(new Error('test'))).toBe(false);
            expect(isHALError(null)).toBe(false);
            expect(isHALError(undefined)).toBe(false);
            expect(isHALError('ENOENT')).toBe(false);
            expect(isHALError({ code: 'ENOENT' })).toBe(false);
        });
    });

    describe('hasErrorCode', () => {
        it('should return true when error has matching code', () => {
            const err = new ENOENT();

            expect(hasErrorCode(err, 'ENOENT')).toBe(true);
        });

        it('should return false when error has different code', () => {
            const err = new ENOENT();

            expect(hasErrorCode(err, 'EACCES')).toBe(false);
        });

        it('should return false for non-HALError', () => {
            const err = new Error('test');

            expect(hasErrorCode(err, 'ENOENT')).toBe(false);
        });
    });

    describe('fromSystemError', () => {
        it('should convert ENOENT', () => {
            const sysErr = Object.assign(new Error('not found'), { code: 'ENOENT' });
            const halErr = fromSystemError(sysErr);

            expect(halErr.code).toBe('ENOENT');
            expect(halErr.message).toBe('not found');
        });

        it('should convert EACCES', () => {
            const sysErr = Object.assign(new Error('permission denied'), { code: 'EACCES' });
            const halErr = fromSystemError(sysErr);

            expect(halErr.code).toBe('EACCES');
        });

        it('should convert ECONNREFUSED', () => {
            const sysErr = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
            const halErr = fromSystemError(sysErr);

            expect(halErr.code).toBe('ECONNREFUSED');
        });

        it('should default to EIO for unknown codes', () => {
            const sysErr = Object.assign(new Error('unknown'), { code: 'UNKNOWN' });
            const halErr = fromSystemError(sysErr);

            expect(halErr.code).toBe('EIO');
        });

        it('should handle missing code', () => {
            const sysErr = new Error('no code');
            const halErr = fromSystemError(sysErr);

            expect(halErr.code).toBe('EIO');
        });
    });
});
