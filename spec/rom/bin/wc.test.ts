/**
 * wc Command Tests
 *
 * Tests for the `wc` command which counts words, lines, and bytes.
 *
 * GNU BEHAVIOR
 * ============
 * - Shows lines, words, and characters by default
 * - -l shows only line count
 * - -w shows only word count
 * - -c shows only character count
 * - Multiple flags can be combined
 * - Shows total line for multiple files
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

describe('wc', () => {
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
        it('should show lines, words, and chars by default', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'hello world\nfoo bar\n');

            const result = await run('wc /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // 2 lines, 4 words, 20 chars
            expect(result.stdout).toContain('2');
            expect(result.stdout).toContain('4');
            expect(result.stdout).toContain('20');
            expect(result.stdout).toContain('/tmp/test.txt');
        });

        it('should handle empty file', async () => {
            await os.fs.writeFile('/tmp/test.txt', '');

            const result = await run('wc /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('0');
        });

        it('should count single line without newline', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'hello');

            const result = await run('wc /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // 0 lines (no newline), 1 word, 5 chars
            expect(result.stdout).toMatch(/\s+0\s+1\s+5/);
        });
    });

    // -------------------------------------------------------------------------
    // Line Count (-l)
    // -------------------------------------------------------------------------

    describe('-l option', () => {
        it('should show only line count with -l', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'line1\nline2\nline3\n');

            const result = await run('wc -l /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/\s+3\s+\/tmp\/test\.txt/);
        });

        it('should count zero lines for empty file', async () => {
            await os.fs.writeFile('/tmp/test.txt', '');

            const result = await run('wc -l /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/\s+0\s+/);
        });
    });

    // -------------------------------------------------------------------------
    // Word Count (-w)
    // -------------------------------------------------------------------------

    describe('-w option', () => {
        it('should show only word count with -w', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'one two three\nfour five\n');

            const result = await run('wc -w /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/\s+5\s+/);
        });

        it('should handle multiple spaces between words', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'word1    word2  word3\n');

            const result = await run('wc -w /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/\s+3\s+/);
        });

        it('should count zero words for whitespace-only file', async () => {
            await os.fs.writeFile('/tmp/test.txt', '   \n  \n');

            const result = await run('wc -w /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/\s+0\s+/);
        });
    });

    // -------------------------------------------------------------------------
    // Character Count (-c)
    // -------------------------------------------------------------------------

    describe('-c option', () => {
        it('should show only character count with -c', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'hello\n');

            const result = await run('wc -c /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/\s+6\s+/); // 5 chars + newline
        });

        it('should count all characters including spaces', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'a b c\n');

            const result = await run('wc -c /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/\s+6\s+/);
        });
    });

    // -------------------------------------------------------------------------
    // Combined Options
    // -------------------------------------------------------------------------

    describe('combined options', () => {
        it('should show lines and words with -lw', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'one two\nthree four\n');

            const result = await run('wc -lw /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // 2 lines, 4 words
            expect(result.stdout).toMatch(/\s+2\s+4\s+/);
        });

        it('should show words and chars with -wc', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'hello world\n');

            const result = await run('wc -wc /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // 2 words, 12 chars
            expect(result.stdout).toMatch(/\s+2\s+12\s+/);
        });

        it('should show all three with -lwc', async () => {
            await os.fs.writeFile('/tmp/test.txt', 'test\n');

            const result = await run('wc -lwc /tmp/test.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // 1 line, 1 word, 5 chars
            expect(result.stdout).toMatch(/\s+1\s+1\s+5\s+/);
        });
    });

    // -------------------------------------------------------------------------
    // Stdin Input
    // -------------------------------------------------------------------------

    describe('stdin', () => {
        it('should read from stdin when no file specified', async () => {
            const result = await run('echo "hello world" | wc');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/\s+1\s+2\s+/);
        });

        it('should count lines from stdin with -l', async () => {
            const result = await run('echo -e "a\\nb\\nc" | wc -l');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/\s+3\s*$/);
        });

        it('should work with piped command output', async () => {
            // TODO: Assumes ls exists and /tmp has files
            const result = await run('ls /tmp | wc -l');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Should have at least 1 line
            expect(result.stdout).toMatch(/\s+\d+/);
        });
    });

    // -------------------------------------------------------------------------
    // Multiple Files
    // -------------------------------------------------------------------------

    describe('multiple files', () => {
        it('should show counts for each file plus total', async () => {
            await os.fs.writeFile('/tmp/file1.txt', 'a b\nc d\n');
            await os.fs.writeFile('/tmp/file2.txt', 'e f\ng h\n');

            const result = await run('wc /tmp/file1.txt /tmp/file2.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('/tmp/file1.txt');
            expect(result.stdout).toContain('/tmp/file2.txt');
            expect(result.stdout).toContain('total');
            // Total: 4 lines, 8 words, 16 chars
            expect(result.stdout).toMatch(/\s+4\s+8\s+16\s+total/);
        });

        it('should show total with -l for multiple files', async () => {
            await os.fs.writeFile('/tmp/file1.txt', 'a\nb\n');
            await os.fs.writeFile('/tmp/file2.txt', 'c\nd\ne\n');

            const result = await run('wc -l /tmp/file1.txt /tmp/file2.txt');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/\s+2\s+\/tmp\/file1\.txt/);
            expect(result.stdout).toMatch(/\s+3\s+\/tmp\/file2\.txt/);
            expect(result.stdout).toMatch(/\s+5\s+total/);
        });

        it('should continue on file error', async () => {
            await os.fs.writeFile('/tmp/exists.txt', 'test\n');

            // TODO: This might need stderr capture
            const result = await run('wc /tmp/missing.txt /tmp/exists.txt 2> /tmp/err');

            // Should still output the second file
            expect(result.stdout).toContain('/tmp/exists.txt');
        });
    });

    // -------------------------------------------------------------------------
    // Pipeline
    // -------------------------------------------------------------------------

    describe('pipeline', () => {
        it('should work in pipeline', async () => {
            const result = await run('echo "a b c" | wc -w | cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toMatch(/\s+3/);
        });

        it('should count lines from find output', async () => {
            // Create some test files
            await os.fs.writeFile('/tmp/a.txt', '');
            await os.fs.writeFile('/tmp/b.txt', '');

            // TODO: Assumes find command exists
            const result = await run('find /tmp -name "*.txt" | wc -l');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Should find at least 2 files
            expect(result.stdout).toMatch(/\s+\d+/);
        });
    });

    // -------------------------------------------------------------------------
    // Error Handling
    // -------------------------------------------------------------------------

    describe('error handling', () => {
        it('should error on missing file', async () => {
            // TODO: Need stderr capture
            const result = await run('wc /tmp/nonexistent.txt 2> /tmp/out');

            expect(result.exitCode).toBe(EXIT.FAILURE);
        });

        it('should continue processing other files after error', async () => {
            await os.fs.writeFile('/tmp/good.txt', 'test\n');

            const result = await run('wc /tmp/missing.txt /tmp/good.txt 2> /tmp/err');

            // Should show count for the good file
            expect(result.stdout).toContain('/tmp/good.txt');
        });
    });
});
