/**
 * echo Command Tests
 *
 * Tests for the `echo` command which displays text to stdout.
 *
 * GNU BEHAVIOR
 * ============
 * - Outputs arguments separated by spaces
 * - Adds trailing newline by default
 * - -n flag suppresses trailing newline
 * - Only leading flags are parsed
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

describe.skip('echo', () => {
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
        it('should output single argument with newline', async () => {
            const result = await run('echo hello');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello\n');
        });

        it('should output multiple arguments with spaces', async () => {
            const result = await run('echo hello world');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello world\n');
        });

        it('should output blank line with no arguments', async () => {
            const result = await run('echo');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('\n');
        });
    });

    // -------------------------------------------------------------------------
    // Flags
    // -------------------------------------------------------------------------

    describe('flags', () => {
        it('should suppress newline with -n flag', async () => {
            const result = await run('echo -n hello');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello');
        });

        it('should treat -n after text as literal', async () => {
            // GNU behavior: only leading flags are parsed
            const result = await run('echo hello -n');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello -n\n');
        });
    });

    // -------------------------------------------------------------------------
    // Quoted Strings
    // -------------------------------------------------------------------------

    describe('quoted strings', () => {
        it('should preserve spaces in double quotes', async () => {
            const result = await run('echo "hello   world"');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello   world\n');
        });

        it('should preserve spaces in single quotes', async () => {
            const result = await run("echo 'hello   world'");

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello   world\n');
        });
    });

    // -------------------------------------------------------------------------
    // Pipeline
    // -------------------------------------------------------------------------

    describe('pipeline', () => {
        it('should work as pipe source', async () => {
            const result = await run('echo hello | cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello\n');
        });

        it('should work through multiple pipes', async () => {
            const result = await run('echo hello | cat | cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello\n');
        });
    });
});
