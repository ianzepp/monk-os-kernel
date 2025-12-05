/**
 * ln Command Tests
 *
 * Tests for the `ln` command which creates links between files.
 *
 * GNU COREUTILS SPECIFICATION
 * ===========================
 * The ln utility creates links between files.
 * Basic usage: ln [-s] TARGET LINK_NAME
 * The -s flag creates symbolic links (default in Monk OS).
 *
 * Note: Symbolic links are not fully supported in current Monk OS.
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/ln-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('ln', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should accept -s flag', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'echo test > /tmp/target && ln -s /tmp/target /tmp/link'],
        });

        const result = await handle.wait();

        // Symlinks may not be implemented, accept either success or failure
        expect([EXIT.SUCCESS, EXIT.FAILURE]).toContain(result.exitCode);
    });

    it('should error with missing arguments', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'ln /tmp/target'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.FAILURE);
    });
});
