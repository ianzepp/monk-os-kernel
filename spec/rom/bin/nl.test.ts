/**
 * nl Command Tests
 *
 * Tests for the `nl` command which numbers lines of files.
 *
 * GNU BEHAVIOR
 * ============
 * - Numbers all lines by default (-b a)
 * - -b t numbers only non-empty lines
 * - -n controls number format (ln/rn/rz)
 * - -w sets number width (default 6)
 * - -s sets separator (default tab)
 * - -v sets starting number (default 1)
 * - -i sets increment (default 1)
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

describe('nl', () => {
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
    // Basic Output
    // -------------------------------------------------------------------------

    describe('basic output', () => {
        it('should number all lines by default', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'first\nsecond\nthird\n');

            const result = await run('nl /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('1');
            expect(result.stdout).toContain('first');
            expect(result.stdout).toContain('2');
            expect(result.stdout).toContain('second');
            expect(result.stdout).toContain('3');
            expect(result.stdout).toContain('third');
        });

        it('should use tab separator by default', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'hello\n');

            const result = await run('nl /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Default format: 6 spaces for number, tab, then text
            expect(result.stdout).toMatch(/\s+1\t+hello/);
        });

        it('should handle empty file', async () => {
            await os.fs.writeFile('/tmp/test.txt', '');

            const result = await run('nl /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('');
        });
    });

    // -------------------------------------------------------------------------
    // Body Numbering Style (-b)
    // -------------------------------------------------------------------------

    describe('-b option', () => {
        it('should number all lines with -b a', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'line1\n\nline3\n');

            const result = await run('nl -b a /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('1');
            expect(result.stdout).toContain('2'); // Empty line gets numbered
            expect(result.stdout).toContain('3');
        });

        it('should skip empty lines with -b t', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'line1\n\nline3\n');

            const result = await run('nl -b t /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('1');
            expect(result.stdout).toContain('line1');
            expect(result.stdout).not.toMatch(/2.*line3/); // Empty line skipped
            expect(result.stdout).toContain('2');
            expect(result.stdout).toContain('line3');
        });

        it('should not number any lines with -b n', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'line1\nline2\n');

            const result = await run('nl -b n /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).not.toMatch(/\d+.*line1/);
            expect(result.stdout).toContain('line1');
            expect(result.stdout).toContain('line2');
        });
    });

    // -------------------------------------------------------------------------
    // Number Format (-n)
    // -------------------------------------------------------------------------

    describe('-n option', () => {
        it('should left-justify with -n ln', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'test\n');

            const result = await run('nl -n ln -w 4 /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Number should be left-justified in 4 chars
            expect(result.stdout).toMatch(/1\s+\ttest/);
        });

        it('should right-justify with spaces with -n rn', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'test\n');

            const result = await run('nl -n rn -w 4 /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Number should be right-justified with spaces
            expect(result.stdout).toMatch(/\s+1\ttest/);
        });

        it('should right-justify with zeros with -n rz', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'test\n');

            const result = await run('nl -n rz -w 4 /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Number should be zero-padded
            expect(result.stdout).toMatch(/0001\ttest/);
        });
    });

    // -------------------------------------------------------------------------
    // Width and Separator
    // -------------------------------------------------------------------------

    describe('width and separator', () => {
        it('should set number width with -w', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'test\n');

            const result = await run('nl -w 3 /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Width should be 3
            expect(result.stdout).toMatch(/\s{0,2}1\ttest/);
        });

        it('should set custom separator with -s', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'test\n');

            const result = await run('nl -s ": " /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('1: test');
        });

        it('should combine width and separator', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'test\n');

            const result = await run('nl -w 2 -s " | " /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain(' 1 | test');
        });
    });

    // -------------------------------------------------------------------------
    // Starting Number and Increment
    // -------------------------------------------------------------------------

    describe('starting number and increment', () => {
        it('should start at custom number with -v', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'a\nb\nc\n');

            const result = await run('nl -v 10 /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('10');
            expect(result.stdout).toContain('11');
            expect(result.stdout).toContain('12');
        });

        it('should use custom increment with -i', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'a\nb\nc\n');

            const result = await run('nl -i 5 /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('1');
            expect(result.stdout).toContain('6');
            expect(result.stdout).toContain('11');
        });

        it('should combine starting number and increment', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'a\nb\nc\n');

            const result = await run('nl -v 100 -i 10 /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('100');
            expect(result.stdout).toContain('110');
            expect(result.stdout).toContain('120');
        });
    });

    // -------------------------------------------------------------------------
    // Stdin Input
    // -------------------------------------------------------------------------

    describe('stdin', () => {
        it('should read from stdin when no file specified', async () => {
            const result = await run('echo -e "line1\\nline2\\nline3" | nl');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('1');
            expect(result.stdout).toContain('2');
            expect(result.stdout).toContain('3');
        });

        it('should work with custom options on stdin', async () => {
            const result = await run('echo -e "a\\nb\\nc" | nl -s ". " -w 2');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('1. a');
            expect(result.stdout).toContain('2. b');
            expect(result.stdout).toContain('3. c');
        });
    });

    // -------------------------------------------------------------------------
    // Pipeline
    // -------------------------------------------------------------------------

    describe('pipeline', () => {
        it('should work in pipeline', async () => {
            const result = await run('echo -e "a\\nb\\nc" | nl -s ": " | cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('1: a');
        });

        it('should number output from other commands', async () => {
            const result = await run('ls /tmp | head -n 3 | nl');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('1');
        });
    });

    // -------------------------------------------------------------------------
    // Error Handling
    // -------------------------------------------------------------------------

    describe('error handling', () => {
        it('should error on missing file', async () => {
            // TODO: Need stderr capture
            const result = await run('nl /tmp/nonexistent.txt 2> /tmp/out');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });

        it('should error on invalid -b value', async () => {
            const result = await run('nl -b invalid /tmp/test.txt 2> /tmp/out');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });

        it('should error on invalid -n value', async () => {
            const result = await run('nl -n invalid /tmp/test.txt 2> /tmp/out');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });

        it('should error on invalid -w value', async () => {
            const result = await run('nl -w abc /tmp/test.txt 2> /tmp/out');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });
    });
});
