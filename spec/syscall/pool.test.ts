/**
 * Pool Syscall Tests
 *
 * Tests for worker pool syscall validation.
 *
 * WHY: These tests validate the syscall layer through the real dispatch chain.
 * Uses TestOS with dispatcher layer to test syscall validation and behavior
 * without mocks, ensuring real integration between syscall handlers and pool.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestOS } from '@src/os/test.js';

describe('Pool Syscalls', () => {
    let os: TestOS;

    beforeEach(async () => {
        os = new TestOS();
        // WHY: Boot with dispatcher layer to enable syscall testing
        // This provides hal, ems, auth, vfs, kernel, dispatcher
        await os.boot({ layers: ['dispatcher'] });
    });

    afterEach(async () => {
        await os.shutdown();
    });

    // =========================================================================
    // pool:lease
    // =========================================================================

    // WHY: pool:lease has no validation - accepts any type for pool name
    // and converts to string or undefined. No EINVAL tests needed.

    // =========================================================================
    // worker:load
    // =========================================================================

    describe('worker:load', () => {
        it('should yield EINVAL when workerId is not a string', async () => {
            await expect(os.syscall('worker:load', 123, '/script.js')).rejects.toThrow('workerId must be a string');
        });

        it('should yield EINVAL when workerId is null', async () => {
            await expect(os.syscall('worker:load', null, '/script.js')).rejects.toThrow('workerId must be a string');
        });

        it('should yield EINVAL when path is not a string', async () => {
            await expect(os.syscall('worker:load', 'worker-id', 456)).rejects.toThrow('path must be a string');
        });

        it('should yield EINVAL when path is undefined', async () => {
            await expect(os.syscall('worker:load', 'worker-id', undefined)).rejects.toThrow('path must be a string');
        });
    });

    // =========================================================================
    // worker:send
    // =========================================================================

    describe('worker:send', () => {
        it('should yield EINVAL when workerId is not a string', async () => {
            await expect(os.syscall('worker:send', undefined, { data: 'test' })).rejects.toThrow('workerId must be a string');
        });

        it('should yield EINVAL when workerId is a number', async () => {
            await expect(os.syscall('worker:send', 42, { data: 'test' })).rejects.toThrow('workerId must be a string');
        });
    });

    // =========================================================================
    // worker:recv
    // =========================================================================

    describe('worker:recv', () => {
        it('should yield EINVAL when workerId is not a string', async () => {
            await expect(os.syscall('worker:recv', {})).rejects.toThrow('workerId must be a string');
        });

        it('should yield EINVAL when workerId is an array', async () => {
            await expect(os.syscall('worker:recv', [])).rejects.toThrow('workerId must be a string');
        });
    });

    // =========================================================================
    // worker:release
    // =========================================================================

    describe('worker:release', () => {
        it('should yield EINVAL when workerId is not a string', async () => {
            await expect(os.syscall('worker:release', false)).rejects.toThrow('workerId must be a string');
        });

        it('should yield EINVAL when workerId is null', async () => {
            await expect(os.syscall('worker:release', null)).rejects.toThrow('workerId must be a string');
        });
    });
});
