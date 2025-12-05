/**
 * sort Command Tests
 *
 * Tests for the `sort` command which sorts lines of text.
 *
 * GNU COREUTILS SPECIFICATION
 * ============================
 * The sort utility writes the sorted concatenation of all input files
 * to standard output. Comparisons are based on the entire line by default.
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/sort-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('sort', () => {
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
    // Basic alphabetic sorting
    // -------------------------------------------------------------------------

    it('should sort lines alphabetically', async () => {
        await os.fs.write('/tmp/input.txt', 'dog\ncat\napple\nbanana\n');

        const result = await run('sort /tmp/input.txt');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('apple\nbanana\ncat\ndog\n');
    });

    it('should sort from stdin', async () => {
        const result = await run('echo "zebra\napple\ncat" | sort');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('apple\ncat\nzebra\n');
    });

    // -------------------------------------------------------------------------
    // Reverse sort
    // -------------------------------------------------------------------------

    it('should sort in reverse order', async () => {
        const result = await run('echo "apple\ncat\nzebra" | sort -r');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('zebra\ncat\napple\n');
    });

    // -------------------------------------------------------------------------
    // Numeric sort
    // -------------------------------------------------------------------------

    it('should sort numbers numerically', async () => {
        const result = await run('echo "10\n2\n100\n20" | sort -n');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('2\n10\n20\n100\n');
    });

    it('should sort numbers in reverse numeric order', async () => {
        const result = await run('echo "10\n2\n100\n20" | sort -rn');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('100\n20\n10\n2\n');
    });

    // -------------------------------------------------------------------------
    // Unique sort
    // -------------------------------------------------------------------------

    it('should remove duplicate lines', async () => {
        const result = await run('echo "apple\nbanana\napple\ncat" | sort -u');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('apple\nbanana\ncat\n');
    });

    // -------------------------------------------------------------------------
    // Case-insensitive sort
    // -------------------------------------------------------------------------

    it('should sort case-insensitively', async () => {
        const result = await run('echo "Zebra\napple\nBanana" | sort -f');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('apple\nBanana\nZebra\n');
    });

    // -------------------------------------------------------------------------
    // Field-based sort
    // -------------------------------------------------------------------------

    it('should sort by field', async () => {
        await os.fs.write('/tmp/data.txt', 'alice:30\nbob:20\ncharlie:25\n');

        const result = await run('sort -t: -k2 -n /tmp/data.txt');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('bob:20\ncharlie:25\nalice:30\n');
    });

    // -------------------------------------------------------------------------
    // Check mode
    // -------------------------------------------------------------------------

    it('should check if input is sorted', async () => {
        const result = await run('echo "apple\nbanana\ncat" | sort -c');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });

    it('should detect unsorted input', async () => {
        const result = await run('echo "zebra\napple\ncat" | sort -c');

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    // -------------------------------------------------------------------------
    // Empty input
    // -------------------------------------------------------------------------

    it('should handle empty input', async () => {
        const result = await run('echo "" | sort');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('\n');
    });
});
