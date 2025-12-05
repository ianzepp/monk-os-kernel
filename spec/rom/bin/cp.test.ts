/**
 * cp Command Tests
 *
 * Tests for the `cp` command which copies files and directories.
 *
 * GNU COREUTILS SPECIFICATION
 * ===========================
 * The cp utility copies files and directories.
 * Basic usage: cp SOURCE DEST
 * With -r flag: recursively copy directories
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/cp-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('cp', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should copy a file', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'echo test > /tmp/src && cp /tmp/src /tmp/dest'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });

    it('should copy directory with -r flag', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'mkdir /tmp/dir && cp -r /tmp/dir /tmp/copy'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });
});
