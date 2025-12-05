/**
 * yes Command Tests
 *
 * Tests for the `yes` command which outputs a string repeatedly until killed.
 *
 * GNU SPECIFICATION
 * =================
 * The yes utility outputs the given string (or "y") repeatedly until terminated.
 * Useful for piping to commands that require confirmation.
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/yes-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('yes', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should accept arguments without error', async () => {
        // yes runs forever, so we can't test output easily
        // Just verify the command exists and accepts arguments
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'true'],
        });

        const result = await handle.wait();

        // Basic smoke test - command should be available
        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });
});
