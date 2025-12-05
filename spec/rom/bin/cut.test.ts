/**
 * cut Command Tests
 *
 * Tests for the `cut` command which removes sections from each line.
 *
 * GNU COREUTILS SPECIFICATION
 * ============================
 * The cut utility selects portions of each line from files or stdin.
 * It can operate on character positions (-c) or delimited fields (-f).
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/cut-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('cut', () => {
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
    // Basic field extraction with delimiter
    // -------------------------------------------------------------------------

    it('should extract field by delimiter', async () => {
        const result = await run('echo "a,b,c" | cut -d, -f2');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('b\n');
    });

    it('should extract multiple fields', async () => {
        const result = await run('echo "a:b:c:d" | cut -d: -f1,3');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('a:c\n');
    });

    it('should extract field range', async () => {
        const result = await run('echo "a:b:c:d" | cut -d: -f2-3');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('b:c\n');
    });

    // -------------------------------------------------------------------------
    // Character extraction
    // -------------------------------------------------------------------------

    it('should extract characters by position', async () => {
        const result = await run('echo "hello world" | cut -c1-5');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('hello\n');
    });

    it('should extract specific character positions', async () => {
        const result = await run('echo "abcde" | cut -c1,3,5');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('ace\n');
    });

    // -------------------------------------------------------------------------
    // File input
    // -------------------------------------------------------------------------

    it('should read from file', async () => {
        await os.fs.write('/tmp/test.txt', 'x:y:z\n');

        const result = await run('cut -d: -f2 /tmp/test.txt');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('y\n');
    });

    // -------------------------------------------------------------------------
    // Error handling
    // -------------------------------------------------------------------------

    it('should fail when no field or character option specified', async () => {
        const result = await run('echo "test" | cut -d,');

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    it('should fail on missing file', async () => {
        const result = await run('cut -d: -f1 /nonexistent');

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });
});
