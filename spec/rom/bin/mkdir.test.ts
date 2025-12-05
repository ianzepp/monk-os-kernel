/**
 * mkdir Command Tests
 *
 * Tests for the `mkdir` command which creates directories.
 *
 * GNU BEHAVIOR
 * ============
 * - Creates directories with specified names
 * - -p flag creates parent directories as needed
 * - With -p, succeeds if directory already exists
 * - Without -p, fails if parent doesn't exist
 * - Continues processing on error (exits 1 if any fail)
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
} as const;

describe('mkdir', () => {
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
    // Basic Directory Creation
    // -------------------------------------------------------------------------

    describe('basic creation', () => {
        it('should create a single directory', async () => {
            const result = await run('mkdir /tmp/testdir && ls /tmp');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('testdir');
        });

        it('should create multiple directories', async () => {
            const result = await run('mkdir /tmp/dir1 /tmp/dir2 && ls /tmp');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('dir1');
            expect(result.stdout).toContain('dir2');
        });

        it('should fail without operand', async () => {
            const result = await run('mkdir 2> /tmp/err; cat /tmp/err');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            expect(result.stdout).toContain('missing operand');
        });
    });

    // -------------------------------------------------------------------------
    // Parent Directory Flag (-p)
    // -------------------------------------------------------------------------

    describe('parent directories', () => {
        it('should create parent directories with -p', async () => {
            const result = await run('mkdir -p /tmp/parent/child && ls /tmp/parent');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('child');
        });

        it('should succeed if directory exists with -p', async () => {
            const result = await run('mkdir /tmp/existing && mkdir -p /tmp/existing');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
        });

        it('should fail if parent missing without -p', async () => {
            // TODO: This test may fail due to error message format differences
            const result = await run('mkdir /tmp/noparent/child 2> /tmp/err; cat /tmp/err');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });
    });

    // -------------------------------------------------------------------------
    // Error Handling
    // -------------------------------------------------------------------------

    describe('error handling', () => {
        it('should fail if directory already exists without -p', async () => {
            const result = await run('mkdir /tmp/dup && mkdir /tmp/dup 2> /tmp/err; cat /tmp/err');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });

        it('should continue on error with multiple directories', async () => {
            // Create one valid, one duplicate - should create the valid one
            const result = await run('mkdir /tmp/dup1 && mkdir /tmp/dup1 /tmp/valid 2> /tmp/err && ls /tmp');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            expect(result.stdout).toContain('valid');
        });
    });
});
