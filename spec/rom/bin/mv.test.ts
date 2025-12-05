/**
 * mv Command Tests
 *
 * Tests for the `mv` command which moves (renames) files and directories.
 *
 * GNU COREUTILS SPECIFICATION
 * ===========================
 * The mv utility renames files or moves them to different directories.
 * Basic usage: mv SOURCE DEST
 * Multiple sources: mv SOURCE... DIRECTORY
 *
 * @see https://www.gnu.org/software/coreutils/manual/html_node/mv-invocation.html
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('mv', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should rename a file', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'echo test > /tmp/old && mv /tmp/old /tmp/new'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });

    it('should move file into directory', async () => {
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'echo test > /tmp/file && mkdir /tmp/dir && mv /tmp/file /tmp/dir/'],
        });

        const result = await handle.wait();

        expect(result.exitCode).toBe(EXIT.SUCCESS);
    });
});
