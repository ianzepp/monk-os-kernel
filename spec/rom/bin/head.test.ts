/**
 * head Command Tests
 *
 * Tests for the `head` command which outputs the first part of files.
 *
 * GNU BEHAVIOR
 * ============
 * - Outputs first 10 lines by default
 * - -n flag specifies number of lines
 * - Supports multiple files with headers
 * - "-" reads from stdin
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
    USAGE: 2,
} as const;

describe('head', () => {
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
    // Help and Usage
    // -------------------------------------------------------------------------

    describe('help', () => {
        it('should show help with --help', async () => {
            const result = await run('head --help');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('Usage:');
            expect(result.stdout).toContain('head');
        });

        it('should show error for invalid option', async () => {
            // TODO: This might fail if stderr isn't captured properly
            const result = await run('head --invalid-option 2> /tmp/out');

            expect(result.exitCode).toBe(EXIT.USAGE);
        });
    });

    // -------------------------------------------------------------------------
    // Basic Output
    // -------------------------------------------------------------------------

    describe('basic output', () => {
        it('should output first 10 lines by default', async () => {
            // Create test file with 15 lines
            await os.fs.writeFile('/tmp/test.txt', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n');

            const result = await run('head /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
        });

        it('should output all lines if fewer than 10', async () => {
            await os.fs.writeFile('/tmp/test.txt', '1\n2\n3\n');

            const result = await run('head /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('1\n2\n3\n');
        });

        it('should handle empty file', async () => {
            await os.fs.writeFile('/tmp/test.txt', '');

            const result = await run('head /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('');
        });
    });

    // -------------------------------------------------------------------------
    // Line Count Option
    // -------------------------------------------------------------------------

    describe('-n option', () => {
        it('should output first N lines with -n flag', async () => {
            await os.fs.writeFile('/tmp/test.txt', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');

            const result = await run('head -n 3 /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('1\n2\n3\n');
        });

        it('should support -n without space', async () => {
            await os.fs.writeFile('/tmp/test.txt', '1\n2\n3\n4\n5\n');

            const result = await run('head -n5 /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('1\n2\n3\n4\n5\n');
        });

        it('should handle -n 0', async () => {
            await os.fs.writeFile('/tmp/test.txt', '1\n2\n3\n');

            const result = await run('head -n 0 /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('');
        });
    });

    // -------------------------------------------------------------------------
    // Stdin Input
    // -------------------------------------------------------------------------

    describe('stdin', () => {
        it('should read from stdin when no file specified', async () => {
            const result = await run('echo -e "1\\n2\\n3\\n4\\n5" | head -n 3');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('1\n2\n3\n');
        });

        it('should read from stdin with "-" argument', async () => {
            const result = await run('echo -e "1\\n2\\n3" | head -n 2 -');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('1\n2\n');
        });
    });

    // -------------------------------------------------------------------------
    // Multiple Files
    // -------------------------------------------------------------------------

    describe('multiple files', () => {
        it('should show headers for multiple files', async () => {
            await os.fs.writeFile('/tmp/file1.txt', 'a\nb\nc\n');
            await os.fs.writeFile('/tmp/file2.txt', 'd\ne\nf\n');

            const result = await run('head -n 2 /tmp/file1.txt /tmp/file2.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('==> /tmp/file1.txt <==');
            expect(result.stdout).toContain('a\nb\n');
            expect(result.stdout).toContain('==> /tmp/file2.txt <==');
            expect(result.stdout).toContain('d\ne\n');
        });

        it('should continue on file error', async () => {
            await os.fs.writeFile('/tmp/exists.txt', '1\n2\n3\n');

            // TODO: This might need stderr capture
            const result = await run('head /tmp/missing.txt /tmp/exists.txt 2> /tmp/err');

            // Should still output the second file
            expect(result.stdout).toContain('1\n2\n3\n');
        });
    });

    // -------------------------------------------------------------------------
    // Error Handling
    // -------------------------------------------------------------------------

    describe('error handling', () => {
        it('should error on missing file', async () => {
            // TODO: Need stderr capture
            const result = await run('head /tmp/nonexistent.txt 2> /tmp/out');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });

        it('should error on invalid -n value', async () => {
            const result = await run('head -n invalid /tmp/test.txt 2> /tmp/out');

            expect(result.exitCode).toBe(EXIT.USAGE);
        });

        it('should error on negative -n value', async () => {
            const result = await run('head -n -5 /tmp/test.txt 2> /tmp/out');

            expect(result.exitCode).toBe(EXIT.USAGE);
        });
    });
});
