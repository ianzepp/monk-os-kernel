/**
 * awk Command Tests
 *
 * Tests for the `awk` command - pattern scanning and text processing language.
 *
 * GNU SPECIFICATION
 * =================
 * The awk utility scans files for lines that match patterns and performs actions.
 * These tests focus on basic smoke tests to verify awk is minimally functional.
 *
 * @see https://www.gnu.org/software/gawk/manual/gawk.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('awk', () => {
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
        const result = await run('awk --help');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toContain('Usage:');
        expect(result.stdout).toContain('awk');
    });

    it('should print first field', async () => {
        const result = await run('echo "a b c" | awk \'{print $1}\'');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('a\n');
    }, { timeout: 10000 });

    it('should print second field', async () => {
        const result = await run('echo "a b c" | awk \'{print $2}\'');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('b\n');
    }, { timeout: 10000 });

    it('should print entire line', async () => {
        const result = await run('echo "hello world" | awk \'{print $0}\'');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('hello world\n');
    }, { timeout: 10000 });

    it('should use custom field separator', async () => {
        const result = await run('echo "a:b:c" | awk -F: \'{print $2}\'');

        expect(result.exitCode).toBe(EXIT.SUCCESS);
        expect(result.stdout).toBe('b\n');
    }, { timeout: 10000 });
});
