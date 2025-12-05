/**
 * rmdir Command Tests
 *
 * Tests for the `rmdir` command which removes empty directories.
 *
 * GNU BEHAVIOR
 * ============
 * - Removes empty directories only
 * - Fails if directory is not empty
 * - Fails if target is a file, not a directory
 * - Continues processing on error (exits 1 if any fail)
 * - For recursive removal, use rm -r instead
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

describe('rmdir', () => {
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
    // Basic Directory Removal
    // -------------------------------------------------------------------------

    describe('basic removal', () => {
        it('should remove an empty directory', async () => {
            const result = await run('mkdir /tmp/empty && rmdir /tmp/empty && ls /tmp');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).not.toContain('empty');
        });

        it('should remove multiple empty directories', async () => {
            const result = await run('mkdir /tmp/dir1 /tmp/dir2 && rmdir /tmp/dir1 /tmp/dir2 && ls /tmp');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).not.toContain('dir1');
            expect(result.stdout).not.toContain('dir2');
        });

        it('should fail without operand', async () => {
            const result = await run('rmdir 2> /tmp/err; cat /tmp/err');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            expect(result.stdout).toContain('missing operand');
        });
    });

    // -------------------------------------------------------------------------
    // Non-Empty Directory Handling
    // -------------------------------------------------------------------------

    describe('non-empty directories', () => {
        it('should fail to remove non-empty directory', async () => {
            // TODO: This test may fail due to error message format differences
            const result = await run('mkdir /tmp/nonempty && touch /tmp/nonempty/file && rmdir /tmp/nonempty 2> /tmp/err; cat /tmp/err');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });
    });

    // -------------------------------------------------------------------------
    // Error Handling
    // -------------------------------------------------------------------------

    describe('error handling', () => {
        it('should fail if directory does not exist', async () => {
            const result = await run('rmdir /tmp/nonexistent 2> /tmp/err; cat /tmp/err');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });

        it('should fail if target is a file', async () => {
            // TODO: This test may fail due to error message format differences
            const result = await run('touch /tmp/file && rmdir /tmp/file 2> /tmp/err; cat /tmp/err');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });

        it('should continue on error with multiple directories', async () => {
            const result = await run('mkdir /tmp/valid && rmdir /tmp/nonexistent /tmp/valid 2> /tmp/err && ls /tmp');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            expect(result.stdout).not.toContain('valid');
        });
    });
});
