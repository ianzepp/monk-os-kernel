/**
 * uniq Command Tests
 *
 * Tests for the `uniq` command which reports or filters out repeated lines.
 *
 * GNU COREUTILS SPECIFICATION
 * ============================
 * The uniq utility reads input comparing adjacent lines, and writes one
 * copy of each input line to output. Repeated lines in the input will not
 * be detected if they are not adjacent.
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/uniq-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('uniq', () => {
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
    // Basic duplicate removal
    // -------------------------------------------------------------------------

    it('should remove adjacent duplicate lines', async () => {
        const result = await run('echo "apple\napple\nbanana\nbanana\nbanana\ncat" | uniq');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('apple\nbanana\ncat\n');
    });

    it('should read from file', async () => {
        await os.fs.write('/tmp/input.txt', 'line1\nline1\nline2\nline2\nline3\n');

        const result = await run('uniq /tmp/input.txt');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('line1\nline2\nline3\n');
    });

    it('should preserve non-adjacent duplicates', async () => {
        const result = await run('echo "apple\nbanana\napple" | uniq');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('apple\nbanana\napple\n');
    });

    // -------------------------------------------------------------------------
    // Count mode
    // -------------------------------------------------------------------------

    it('should show count of occurrences', async () => {
        const result = await run('echo "apple\napple\napple\nbanana" | uniq -c');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toContain('3 apple');
        expect(result.stdout).toContain('1 banana');
    });

    // -------------------------------------------------------------------------
    // Duplicates only mode
    // -------------------------------------------------------------------------

    it('should show only duplicate lines', async () => {
        const result = await run('echo "apple\napple\nbanana\ncat\ncat" | uniq -d');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('apple\ncat\n');
    });

    // -------------------------------------------------------------------------
    // Unique only mode
    // -------------------------------------------------------------------------

    it('should show only unique lines', async () => {
        const result = await run('echo "apple\napple\nbanana\ncat\ncat" | uniq -u');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('banana\n');
    });

    // -------------------------------------------------------------------------
    // Case-insensitive mode
    // -------------------------------------------------------------------------

    it('should ignore case when comparing', async () => {
        const result = await run('echo "Apple\napple\nAPPLE\nbanana" | uniq -i');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('Apple\nbanana\n');
    });

    // -------------------------------------------------------------------------
    // Combined with sort
    // -------------------------------------------------------------------------

    it('should work with sort to remove all duplicates', async () => {
        const result = await run('echo "apple\nbanana\napple\ncat\nbanana" | sort | uniq');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('apple\nbanana\ncat\n');
    });

    // -------------------------------------------------------------------------
    // Empty and single line input
    // -------------------------------------------------------------------------

    it('should handle single line', async () => {
        const result = await run('echo "single" | uniq');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('single\n');
    });

    it('should handle empty input', async () => {
        const result = await run('echo "" | uniq');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('\n');
    });

    // -------------------------------------------------------------------------
    // Error handling
    // -------------------------------------------------------------------------

    it('should fail on missing file', async () => {
        const result = await run('uniq /nonexistent');

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });
});
