/**
 * uname Command Tests
 *
 * Tests for the `uname` command which prints system information.
 *
 * GNU BEHAVIOR
 * ============
 * - Default (-s): prints kernel name
 * - -a: prints all information
 * - -n: prints network node hostname
 * - -r: prints kernel release
 * - -v: prints kernel version
 * - -m: prints machine hardware name
 * - -o: prints operating system name
 * - Multiple flags can be combined
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

describe('uname', () => {
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
        it('should output kernel name by default', async () => {
            const result = await run('uname');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('Monk\n');
        });

        it('should output kernel name with -s flag', async () => {
            const result = await run('uname -s');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('Monk\n');
        });

        it('should output all information with -a flag', async () => {
            const result = await run('uname -a');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('Monk');
            expect(result.stdout).toContain('1.0.0');
            expect(result.stdout).toContain('virtual');
            expect(result.stdout).toContain('MonkOS');
        });
    });

    // -------------------------------------------------------------------------
    // Individual Flags
    // -------------------------------------------------------------------------

    describe('individual flags', () => {
        it('should output hostname with -n flag', async () => {
            const result = await run('uname -n');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBeTruthy();
            // Hostname should be 'localhost' or from HOSTNAME env var
            expect(result.stdout.trim()).toBeTruthy();
        });

        it('should output kernel release with -r flag', async () => {
            const result = await run('uname -r');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('1.0.0\n');
        });

        it('should output kernel version with -v flag', async () => {
            const result = await run('uname -v');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toContain('#1 SMP');
        });

        it('should output machine type with -m flag', async () => {
            const result = await run('uname -m');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('virtual\n');
        });

        it('should output operating system with -o flag', async () => {
            const result = await run('uname -o');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('MonkOS\n');
        });
    });

    // -------------------------------------------------------------------------
    // Combined Flags
    // -------------------------------------------------------------------------

    describe('combined flags', () => {
        it('should combine -s and -r flags', async () => {
            const result = await run('uname -sr');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('Monk 1.0.0\n');
        });

        it('should combine -s, -r, and -m flags', async () => {
            const result = await run('uname -srm');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('Monk 1.0.0 virtual\n');
        });

        it('should handle long flag names', async () => {
            const result = await run('uname --kernel-name');

            expect(result.exitCode).toBe(EXIT.SUCCESS);
            expect(result.stdout).toBe('Monk\n');
        });
    });
});
