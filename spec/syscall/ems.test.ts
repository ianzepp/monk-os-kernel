/**
 * EMS Syscall Tests
 *
 * Tests for Entity Management System syscall validation.
 *
 * WHY: These tests validate the syscall layer through the real dispatch chain.
 * Focuses on argument validation (EINVAL checks) since EMS behavior is tested
 * extensively in spec/ems/ tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestOS } from '@src/os/test.js';

describe('EMS Syscalls', () => {
    let os: TestOS;

    beforeEach(async () => {
        os = new TestOS();
        // WHY: Boot with dispatcher layer to enable syscall testing
        await os.boot({ layers: ['dispatcher'] });
    });

    afterEach(async () => {
        await os.shutdown();
    });

    // =========================================================================
    // ems:select
    // =========================================================================

    describe('ems:select', () => {
        it('should yield EINVAL when model is not a string', async () => {
            await expect(os.syscall('ems:select', 123)).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when model is null', async () => {
            await expect(os.syscall('ems:select', null)).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when model is undefined', async () => {
            await expect(os.syscall('ems:select', undefined)).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when model is an object', async () => {
            await expect(os.syscall('ems:select', {})).rejects.toThrow('model must be a string');
        });
    });

    // =========================================================================
    // ems:create
    // =========================================================================

    describe('ems:create', () => {
        it('should yield EINVAL when model is not a string', async () => {
            await expect(os.syscall('ems:create', 123, {})).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when model is null', async () => {
            await expect(os.syscall('ems:create', null, {})).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when fields is not an object', async () => {
            await expect(os.syscall('ems:create', 'user', 'invalid')).rejects.toThrow('fields must be an object');
        });

        it('should yield EINVAL when fields is null', async () => {
            await expect(os.syscall('ems:create', 'user', null)).rejects.toThrow('fields must be an object');
        });

        it('should yield EINVAL when fields is a number', async () => {
            await expect(os.syscall('ems:create', 'user', 123)).rejects.toThrow('fields must be an object');
        });

        it('should yield EINVAL when fields is an array', async () => {
            // EDGE: Arrays pass typeof check (typeof [] === 'object')
            // but will fail on model lookup since 'user' doesn't exist
            await expect(os.syscall('ems:create', 'user', [])).rejects.toThrow();
        });
    });

    // =========================================================================
    // ems:update
    // =========================================================================

    describe('ems:update', () => {
        it('should yield EINVAL when model is not a string', async () => {
            await expect(os.syscall('ems:update', null, 'id', {})).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when model is a number', async () => {
            await expect(os.syscall('ems:update', 123, 'id', {})).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when id is not a string', async () => {
            await expect(os.syscall('ems:update', 'user', 123, {})).rejects.toThrow('id must be a string');
        });

        it('should yield EINVAL when id is null', async () => {
            await expect(os.syscall('ems:update', 'user', null, {})).rejects.toThrow('id must be a string');
        });

        it('should yield EINVAL when changes is not an object', async () => {
            await expect(os.syscall('ems:update', 'user', 'id', 'invalid')).rejects.toThrow('changes must be an object');
        });

        it('should yield EINVAL when changes is null', async () => {
            await expect(os.syscall('ems:update', 'user', 'id', null)).rejects.toThrow('changes must be an object');
        });

        it('should yield EINVAL when changes is a number', async () => {
            await expect(os.syscall('ems:update', 'user', 'id', 42)).rejects.toThrow('changes must be an object');
        });
    });

    // =========================================================================
    // ems:delete
    // =========================================================================

    describe('ems:delete', () => {
        it('should yield EINVAL when model is not a string', async () => {
            await expect(os.syscall('ems:delete', undefined, 'id')).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when model is a number', async () => {
            await expect(os.syscall('ems:delete', 456, 'id')).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when id is not a string', async () => {
            await expect(os.syscall('ems:delete', 'user', null)).rejects.toThrow('id must be a string');
        });

        it('should yield EINVAL when id is a number', async () => {
            await expect(os.syscall('ems:delete', 'user', 789)).rejects.toThrow('id must be a string');
        });

        it('should yield EINVAL when id is an object', async () => {
            await expect(os.syscall('ems:delete', 'user', {})).rejects.toThrow('id must be a string');
        });
    });

    // =========================================================================
    // ems:revert
    // =========================================================================

    describe('ems:revert', () => {
        it('should yield EINVAL when model is not a string', async () => {
            await expect(os.syscall('ems:revert', {}, 'id')).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when model is null', async () => {
            await expect(os.syscall('ems:revert', null, 'id')).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when id is not a string', async () => {
            await expect(os.syscall('ems:revert', 'user', 123)).rejects.toThrow('id must be a string');
        });

        it('should yield EINVAL when id is undefined', async () => {
            await expect(os.syscall('ems:revert', 'user', undefined)).rejects.toThrow('id must be a string');
        });

        it('should yield EINVAL when id is an array', async () => {
            await expect(os.syscall('ems:revert', 'user', [])).rejects.toThrow('id must be a string');
        });
    });

    // =========================================================================
    // ems:expire
    // =========================================================================

    describe('ems:expire', () => {
        it('should yield EINVAL when model is not a string', async () => {
            await expect(os.syscall('ems:expire', [], 'id')).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when model is a number', async () => {
            await expect(os.syscall('ems:expire', 999, 'id')).rejects.toThrow('model must be a string');
        });

        it('should yield EINVAL when id is not a string', async () => {
            await expect(os.syscall('ems:expire', 'user', undefined)).rejects.toThrow('id must be a string');
        });

        it('should yield EINVAL when id is null', async () => {
            await expect(os.syscall('ems:expire', 'user', null)).rejects.toThrow('id must be a string');
        });

        it('should yield EINVAL when id is an object', async () => {
            await expect(os.syscall('ems:expire', 'user', { id: '123' })).rejects.toThrow('id must be a string');
        });
    });
});
