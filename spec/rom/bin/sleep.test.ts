/**
 * sleep Command Tests
 *
 * Tests for the `sleep` command which delays for a specified duration.
 *
 * GNU BEHAVIOR
 * ============
 * - Accepts duration with suffixes: s (seconds), ms (milliseconds), m (minutes), h (hours)
 * - Default suffix is seconds
 * - Supports decimal values (e.g., 0.5)
 * - Can be interrupted with SIGTERM (exit 130)
 * - Exits 0 on successful completion
 *
 * NOTE: These tests are currently skipped because shell external command
 * execution has issues. Enable when shell is fixed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
    INTERRUPTED: 130,
} as const;

describe('sleep', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    /**
     * Helper to run a shell command and capture output.
     */
    async function run(command: string): Promise<{ exitCode: number; stdout: string }> {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', `${command} > /tmp/out`],
        });

        const result = await handle.wait();
        const stdout = await os.fs.readText('/tmp/out');

        return { exitCode: result.exitCode, stdout };
    }

    // -------------------------------------------------------------------------
    // Basic Duration
    // -------------------------------------------------------------------------

    describe('basic duration', () => {
        it('should sleep for short duration in milliseconds', async () => {
            const start = Date.now();
            const result = await run('sleep 100ms');
            const elapsed = Date.now() - start;

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('');
            expect(elapsed).toBeGreaterThanOrEqual(90);
        });

        it('should sleep for short duration in seconds', async () => {
            const start = Date.now();
            const result = await run('sleep 0.1');
            const elapsed = Date.now() - start;

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('');
            expect(elapsed).toBeGreaterThanOrEqual(90);
        });

        it('should sleep with explicit seconds suffix', async () => {
            const start = Date.now();
            const result = await run('sleep 0.1s');
            const elapsed = Date.now() - start;

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('');
            expect(elapsed).toBeGreaterThanOrEqual(90);
        });
    });

    // -------------------------------------------------------------------------
    // Error Handling
    // -------------------------------------------------------------------------

    describe('error handling', () => {
        it('should fail with missing operand', async () => {
            const result = await run('sleep 2>&1');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            expect(result.stdout).toContain('missing operand');
        });

        it('should fail with invalid duration', async () => {
            const result = await run('sleep invalid 2>&1');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            expect(result.stdout).toContain('invalid time interval');
        });

        it('should fail with negative duration', async () => {
            const result = await run('sleep -5 2>&1');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            expect(result.stdout).toContain('invalid time interval');
        });
    });

    // -------------------------------------------------------------------------
    // Duration Units
    // -------------------------------------------------------------------------

    describe('duration units', () => {
        it('should accept milliseconds suffix', async () => {
            const result = await run('sleep 50ms');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
        });

        it('should accept seconds suffix', async () => {
            const result = await run('sleep 0.05s');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
        });

        it('should accept minutes suffix', async () => {
            // TODO: This will likely take 3 seconds, ensure test timeout is appropriate
            const result = await run('sleep 0.05m');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
        });
    });
});
