/**
 * Spawn and Wait Integration Tests
 *
 * Tests process creation and lifecycle:
 * - Parent spawns child
 * - Child runs and exits
 * - Parent waits and gets exit status
 */

import { describe, it, expect } from 'bun:test';
import { ETIMEDOUT, ESRCH, ECHILD } from '@src/kernel/errors.js';

// TODO: Create proper test fixtures for spawn integration tests
// Requires: rom/bin/test-parent.ts, rom/bin/test-child.ts
describe.skip('Spawn and Wait', () => {
    it.skip('should spawn child and wait for exit', () => {});
    it.skip('should report correct exit code from child', () => {});
    it.skip('should handle child that exits with 0', () => {});
    it.skip('should assign correct PIDs', () => {});
    it.skip('should track multiple children in process table', () => {});
});

describe.skip('Spawn Errors', () => {
    it.skip('should handle spawn of non-existent file', () => {});
});

describe('Wait Syscall Errors', () => {
    it('should have ETIMEDOUT error for wait timeout', () => {
        const error = new ETIMEDOUT('wait() timed out after 1000ms');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('ETIMEDOUT');
        expect(error.message).toContain('timed out');
    });

    it('should have ESRCH error for non-existent process', () => {
        const error = new ESRCH('No such process: 999');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('ESRCH');
    });

    it('should have ECHILD error for non-child process', () => {
        const error = new ECHILD('Process 5 is not a child');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('ECHILD');
    });
});

// TODO: Create integration tests with test fixtures
describe.skip('Wait with Timeout', () => {
    it.skip('should wait indefinitely with no timeout', () => {
        // wait(pid) with no timeout waits forever until child exits
    });

    it.skip('should return immediately if child is already zombie', () => {
        // wait(pid, timeout) returns immediately if child already exited
    });

    it.skip('should throw ETIMEDOUT if timeout expires before child exits', () => {
        // wait(pid, 100) throws ETIMEDOUT after 100ms if child still running
    });

    it.skip('should return exit status if child exits within timeout', () => {
        // wait(pid, 5000) returns exit status if child exits in < 5s
    });
});
