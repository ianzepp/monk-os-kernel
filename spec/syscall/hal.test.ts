/**
 * HAL Syscall Tests
 *
 * Tests for network and channel syscall validation and behavior.
 *
 * WHY: These tests validate the syscall layer through the real dispatch chain.
 * Uses TestOS with dispatcher layer to test syscall validation and behavior
 * without mocks, ensuring real integration between syscall handlers and HAL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestOS } from '@src/os/test.js';

describe('HAL Syscalls', () => {
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
    // net:connect
    // =========================================================================

    describe('net:connect', () => {
        it('should yield EINVAL when proto is not a string', async () => {
            await expect(os.syscall('net:connect', 123, 'localhost', 80)).rejects.toThrow('proto must be a string');
        });

        it('should yield EINVAL when host is not a string', async () => {
            await expect(os.syscall('net:connect', 'tcp', null, 80)).rejects.toThrow('host must be a string');
        });

        it('should yield EINVAL when port is not a number for tcp', async () => {
            await expect(os.syscall('net:connect', 'tcp', 'localhost', 'invalid')).rejects.toThrow('port must be a number');
        });

        it('should yield EINVAL for unsupported protocol', async () => {
            await expect(os.syscall('net:connect', 'invalid', 'localhost', 80)).rejects.toThrow('unsupported protocol');
        });
    });

    // =========================================================================
    // port:create
    // =========================================================================

    describe('port:create', () => {
        it('should yield EINVAL when type is not a string', async () => {
            await expect(os.syscall('port:create', 123)).rejects.toThrow('type must be a string');
        });

        it('should yield EINVAL when type is null', async () => {
            await expect(os.syscall('port:create', null)).rejects.toThrow('type must be a string');
        });
    });

    // =========================================================================
    // port:close
    // =========================================================================

    describe('port:close', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('port:close', 'invalid')).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // port:recv
    // =========================================================================

    describe('port:recv', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('port:recv', null)).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // port:send
    // =========================================================================

    describe('port:send', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('port:send', 'invalid', 'addr', new Uint8Array())).rejects.toThrow('fd must be a number');
        });

        it('should yield EINVAL when to is not a string', async () => {
            await expect(os.syscall('port:send', 5, null, new Uint8Array())).rejects.toThrow('to must be a string');
        });

        it('should yield EINVAL when data is not Uint8Array', async () => {
            await expect(os.syscall('port:send', 5, 'addr', 'string data')).rejects.toThrow('data must be Uint8Array');
        });
    });

    // =========================================================================
    // channel:open
    // =========================================================================

    describe('channel:open', () => {
        it('should yield EINVAL when proto is not a string', async () => {
            await expect(os.syscall('channel:open', 123, 'http://test')).rejects.toThrow('proto must be a string');
        });

        it('should yield EINVAL when url is not a string', async () => {
            await expect(os.syscall('channel:open', 'http', null)).rejects.toThrow('url must be a string');
        });
    });

    // =========================================================================
    // channel:close
    // =========================================================================

    describe('channel:close', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('channel:close', {})).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // channel:call
    // =========================================================================

    describe('channel:call', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('channel:call', 'string', {})).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // channel:stream
    // =========================================================================

    describe('channel:stream', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('channel:stream', undefined, {})).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // channel:push
    // =========================================================================

    describe('channel:push', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('channel:push', [], {})).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // channel:recv
    // =========================================================================

    describe('channel:recv', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('channel:recv', false)).rejects.toThrow('fd must be a number');
        });
    });
});
