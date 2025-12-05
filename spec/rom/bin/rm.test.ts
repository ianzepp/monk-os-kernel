/**
 * rm Command Tests
 *
 * Tests for the `rm` command which removes files and directories.
 *
 * GNU BEHAVIOR
 * ============
 * - Removes files by default
 * - Fails on directories without -r flag
 * - -r/-R flag removes directories recursively
 * - -f flag forces removal, ignores nonexistent files
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

describe('rm', () => {
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
    // Basic File Removal
    // -------------------------------------------------------------------------

    describe('basic removal', () => {
        it('should remove a file', async () => {
            const result = await run('touch /tmp/file && rm /tmp/file && ls /tmp');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).not.toContain('file');
        });

        it('should remove multiple files', async () => {
            const result = await run('touch /tmp/file1 /tmp/file2 && rm /tmp/file1 /tmp/file2 && ls /tmp');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).not.toContain('file1');
            expect(result.stdout).not.toContain('file2');
        });

        it('should fail without operand', async () => {
            const result = await run('rm 2> /tmp/err; cat /tmp/err');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            expect(result.stdout).toContain('missing operand');
        });
    });

    // -------------------------------------------------------------------------
    // Directory Removal (-r flag)
    // -------------------------------------------------------------------------

    describe('directory removal', () => {
        it('should fail to remove directory without -r', async () => {
            const result = await run('mkdir /tmp/dir && rm /tmp/dir 2> /tmp/err; cat /tmp/err');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            expect(result.stdout).toContain('is a directory');
        });

        it('should remove empty directory with -r', async () => {
            const result = await run('mkdir /tmp/dir && rm -r /tmp/dir && ls /tmp');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).not.toContain('dir');
        });

        it('should remove directory with contents recursively', async () => {
            const result = await run('mkdir /tmp/parent && touch /tmp/parent/file && rm -r /tmp/parent && ls /tmp');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).not.toContain('parent');
        });

        it('should accept -R as alternative to -r', async () => {
            const result = await run('mkdir /tmp/dir && rm -R /tmp/dir && ls /tmp');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).not.toContain('dir');
        });
    });

    // -------------------------------------------------------------------------
    // Force Flag (-f)
    // -------------------------------------------------------------------------

    describe('force flag', () => {
        it('should succeed on nonexistent file with -f', async () => {
            const result = await run('rm -f /tmp/nonexistent');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
        });

        it('should fail on nonexistent file without -f', async () => {
            const result = await run('rm /tmp/nonexistent 2> /tmp/err; cat /tmp/err');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });
    });

    // -------------------------------------------------------------------------
    // Error Handling
    // -------------------------------------------------------------------------

    describe('error handling', () => {
        it('should fail if file does not exist', async () => {
            const result = await run('rm /tmp/nonexistent 2> /tmp/err; cat /tmp/err');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });

        it('should continue on error with multiple files', async () => {
            const result = await run('touch /tmp/valid && rm /tmp/nonexistent /tmp/valid 2> /tmp/err && ls /tmp');

            expect(result.exitCode).toBe(EXIT.FAILURE);
            expect(result.stdout).not.toContain('valid');
        });
    });
});
