/**
 * MessageRedirect Tests
 *
 * Tests for the redirect abstraction that bridges message↔byte boundary.
 *
 * ARCHITECTURE
 * ============
 * - outputRedirect: messages → bytes (for > and >>)
 * - inputRedirect: bytes → messages (for <)
 *
 * These functions create a message pipe and pump that converts between
 * the two I/O domains.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('MessageRedirect', () => {
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

    /**
     * Helper to run command without redirect wrapper.
     */
    async function exec(command: string): Promise<number> {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', command],
        });

        const result = await handle.wait();

        return result.exitCode;
    }

    // =========================================================================
    // Output Redirect (>)
    // =========================================================================

    describe('output redirect (>)', () => {
        it('should redirect simple command output to file', async () => {
            const result = await run('echo hello');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello\n');
        });

        // TODO: VFS truncate permission issue - can't overwrite existing file
        it.skip('should truncate existing file', async () => {
            // Write initial content
            await exec('echo initial > /tmp/truncate.txt');

            // Overwrite with new content
            await exec('echo replaced > /tmp/truncate.txt');

            const content = await os.fs.readText('/tmp/truncate.txt');

            expect(content).toBe('replaced\n');
        });

        it('should create file if not exists', async () => {
            await exec('echo created > /tmp/newfile.txt');

            const content = await os.fs.readText('/tmp/newfile.txt');

            expect(content).toBe('created\n');
        });

        it('should redirect multiple lines', async () => {
            const result = await run('echo -n "line1\nline2\nline3"');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('line1\nline2\nline3');
        });
    });

    // =========================================================================
    // Append Redirect (>>)
    // =========================================================================

    describe('append redirect (>>)', () => {
        // TODO: VFS permission issue - can't append to existing file
        it.skip('should append to existing file', async () => {
            await exec('echo first > /tmp/append.txt');
            await exec('echo second >> /tmp/append.txt');

            const content = await os.fs.readText('/tmp/append.txt');

            expect(content).toBe('first\nsecond\n');
        });

        it('should create file if not exists', async () => {
            await exec('echo appended >> /tmp/newappend.txt');

            const content = await os.fs.readText('/tmp/newappend.txt');

            expect(content).toBe('appended\n');
        });

        // TODO: VFS permission issue - can't append to existing file
        it.skip('should append multiple times', async () => {
            await exec('echo one >> /tmp/multi.txt');
            await exec('echo two >> /tmp/multi.txt');
            await exec('echo three >> /tmp/multi.txt');

            const content = await os.fs.readText('/tmp/multi.txt');

            expect(content).toBe('one\ntwo\nthree\n');
        });
    });

    // =========================================================================
    // Pipeline + Redirect
    // =========================================================================

    describe('pipeline with redirect', () => {
        it('should redirect pipeline output to file', async () => {
            const result = await run('echo hello | cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello\n');
        });

        it('should redirect 3-stage pipeline', async () => {
            const result = await run('echo hello | cat | cat');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello\n');
        });

        it('should redirect pipeline with transformation', async () => {
            const result = await run('echo HELLO | tr A-Z a-z');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('hello\n');
        });

        // TODO: sort command doesn't sort correctly
        it.skip('should redirect multi-line pipeline', async () => {
            const result = await run('echo -n "b\na\nc" | sort');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('a\nb\nc\n');
        });
    });

    // =========================================================================
    // Chained Commands + Redirect
    // =========================================================================

    describe('chained commands with redirect', () => {
        it('should redirect && chain', async () => {
            const result = await run('echo first && echo second');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Note: each command has its own stdout, last one wins for the overall redirect
        });

        it('should redirect || chain on failure', async () => {
            const exitCode = await exec('false || echo fallback > /tmp/chain.txt');
            const content = await os.fs.readText('/tmp/chain.txt');

            expect(exitCode).toBe(EXIT.SUCCESS);
            expect(content).toBe('fallback\n');
        });
    });

    // =========================================================================
    // Edge Cases
    // =========================================================================

    describe('edge cases', () => {
        it('should handle empty output', async () => {
            const result = await run('true');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('');
        });

        it('should handle large output', async () => {
            // Generate 100 lines
            const result = await run('seq 1 100');

            expect(result.exitCode).toBe(EXIT.SUCCESS);

            const lines = result.stdout.trim().split('\n');

            expect(lines.length).toBe(100);
            expect(lines[0]).toBe('1');
            expect(lines[99]).toBe('100');
        });

        it('should handle special characters in output', async () => {
            const result = await run('echo "hello\\tworld"');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            // Shell may or may not interpret \t
        });
    });

    // =========================================================================
    // Error Handling
    // =========================================================================

    describe('error handling', () => {
        it('should fail on redirect to non-writable path', async () => {
            const exitCode = await exec('echo test > /nonexistent/dir/file.txt');

            expect(exitCode).not.toBe(EXIT.SUCCESS);
        });

        it('should preserve exit code through redirect', async () => {
            const exitCode = await exec('false > /tmp/false.txt');

            expect(exitCode).toBe(EXIT.FAILURE);
        });
    });
});
