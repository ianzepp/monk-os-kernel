/**
 * tr Command Tests
 *
 * Tests for the `tr` command which translates or deletes characters.
 *
 * GNU COREUTILS SPECIFICATION
 * ============================
 * The tr utility translates, squeezes, and/or deletes characters from
 * standard input, writing the result to standard output.
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/tr-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('tr', () => {
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
    // Character translation
    // -------------------------------------------------------------------------

    it('should translate characters', async () => {
        const result = await run('echo "hello" | tr e o');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('hollo\n');
    });

    it('should translate character ranges', async () => {
        const result = await run('echo "hello" | tr a-z A-Z');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('HELLO\n');
    });

    it('should translate lowercase to uppercase', async () => {
        const result = await run('echo "Test123" | tr a-z A-Z');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('TEST123\n');
    });

    // -------------------------------------------------------------------------
    // Character deletion
    // -------------------------------------------------------------------------

    it('should delete characters', async () => {
        const result = await run('echo "hello" | tr -d l');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('heo\n');
    });

    it('should delete vowels', async () => {
        const result = await run('echo "hello world" | tr -d aeiou');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('hll wrld\n');
    });

    // -------------------------------------------------------------------------
    // Character squeezing
    // -------------------------------------------------------------------------

    it('should squeeze repeated characters', async () => {
        const result = await run('echo "heeello" | tr -s e');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('helo\n');
    });

    it('should squeeze spaces', async () => {
        const result = await run('echo "hello    world" | tr -s " "');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('hello world\n');
    });

    // -------------------------------------------------------------------------
    // Error handling
    // -------------------------------------------------------------------------

    it('should fail when no operand provided', async () => {
        const result = await run('echo "test" | tr');

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });

    it('should fail when SET2 missing for translation', async () => {
        const result = await run('echo "test" | tr a-z');

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });
});
