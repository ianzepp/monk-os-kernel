/**
 * basename Command Tests
 *
 * Tests for the `basename` command which strips directory and suffix from filenames.
 *
 * GNU BEHAVIOR
 * ============
 * - Strips directory components, returning only the filename
 * - Can optionally remove a trailing suffix
 * - Supports -a for multiple arguments
 * - Supports -s SUFFIX to remove suffix from multiple files
 * - Removes trailing slashes before processing
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

describe('basename', () => {
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
    // Basic Usage
    // -------------------------------------------------------------------------

    describe('basic usage', () => {
        it('should strip directory from absolute path', async () => {
            const result = await run('basename /usr/bin/cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('cat\n');
        });

        it('should strip directory from nested path', async () => {
            const result = await run('basename /home/user/file.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('file.txt\n');
        });

        it('should return filename when no directory', async () => {
            const result = await run('basename file.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('file.txt\n');
        });

        it('should handle root directory', async () => {
            const result = await run('basename /');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('/\n');
        });

        it('should remove trailing slashes', async () => {
            const result = await run('basename /home/user/');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('user\n');
        });
    });

    // -------------------------------------------------------------------------
    // Suffix Removal
    // -------------------------------------------------------------------------

    describe('suffix removal', () => {
        it('should remove suffix from filename', async () => {
            const result = await run('basename file.txt .txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('file\n');
        });

        it('should remove suffix from path', async () => {
            const result = await run('basename /home/user/file.txt .txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('file\n');
        });

        it('should not remove suffix if it is the entire name', async () => {
            const result = await run('basename .txt .txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('.txt\n');
        });

        it('should not remove suffix if not present', async () => {
            const result = await run('basename file.txt .log');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('file.txt\n');
        });
    });

    // -------------------------------------------------------------------------
    // Multiple Files (-a flag)
    // -------------------------------------------------------------------------

    describe('multiple files', () => {
        it('should process multiple files with -a flag', async () => {
            const result = await run('basename -a /usr/bin/cat /usr/bin/ls');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('cat\nls\n');
        });

        it('should process multiple files with -s flag', async () => {
            const result = await run('basename -s .txt a.txt b.txt c.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('a\nb\nc\n');
        });
    });

    // -------------------------------------------------------------------------
    // Error Cases
    // -------------------------------------------------------------------------

    describe('error cases', () => {
        // TODO: This test might fail - shell may exit differently on error
        it('should error with no arguments', async () => {
            const result = await run('basename 2>&1');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });
    });
});
