/**
 * sed Command Tests
 *
 * Tests for the `sed` command - stream editor for filtering and transforming text.
 *
 * GNU SPECIFICATION
 * =================
 * The sed utility is a stream editor that performs text transformations on an input stream.
 * These tests focus on basic smoke tests to verify sed is minimally functional.
 *
 * @see https://www.gnu.org/software/sed/manual/sed.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('sed', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    /**
     * Helper to run shell command and capture output.
     */
    async function run(command: string): Promise<{ exitCode: number; stdout: string }> {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', `${command} > /tmp/out`],
        });

        const result = await handle.wait();
        const stdout = await os.fs.readText('/tmp/out');

        return { exitCode: result.exitCode, stdout };
    }

    it('should show help with --help', async () => {
        const result = await run('sed --help');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toContain('Usage:');
        expect(result.stdout).toContain('sed');
    });

    it('should perform basic substitution', async () => {
        const result = await run('echo hello | sed \'s/hello/world/\'');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('world\n');
    }, { timeout: 10000 });

    it('should perform global substitution', async () => {
        const result = await run('echo "foo foo" | sed \'s/foo/bar/g\'');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('bar bar\n');
    }, { timeout: 10000 });

    it('should pass through unchanged text', async () => {
        const result = await run('echo unchanged | sed \'s/foo/bar/\'');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('unchanged\n');
    }, { timeout: 10000 });
});
