/**
 * BinMount - Command registry as filesystem
 *
 * Exposes built-in commands as executable files:
 * - /bin/           → list of commands
 * - /bin/{cmd}      → command "executable"
 *
 * Reading a command file returns its description/usage from the man page
 * if available, otherwise a placeholder.
 *
 * Read-only mount.
 */

import type { Mount, FSEntry } from '../types.js';
import { FSError } from '../types.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAN_DIR = join(__dirname, '../../tty/man');

export class BinMount implements Mount {
    constructor(private readonly commandNames: string[]) {}

    async stat(path: string): Promise<FSEntry> {
        const name = path.replace(/^\/+/, '');

        if (name === '') {
            return {
                name: 'bin',
                type: 'directory',
                size: 0,
                mode: 0o755,
            };
        }

        if (this.commandNames.includes(name)) {
            return {
                name,
                type: 'file',
                size: 0,
                mode: 0o755, // executable
            };
        }

        throw new FSError('ENOENT', path);
    }

    async readdir(path: string): Promise<FSEntry[]> {
        const name = path.replace(/^\/+/, '');

        if (name !== '') {
            throw new FSError('ENOTDIR', path);
        }

        return this.commandNames.map(cmd => ({
            name: cmd,
            type: 'file' as const,
            size: 0,
            mode: 0o755,
        }));
    }

    async read(path: string): Promise<string> {
        const name = path.replace(/^\/+/, '');

        if (name === '') {
            throw new FSError('EISDIR', path);
        }

        if (!this.commandNames.includes(name)) {
            throw new FSError('ENOENT', path);
        }

        // Try to read man page
        try {
            const manPath = join(MAN_DIR, name);
            const content = await readFile(manPath, 'utf-8');
            return content;
        } catch {
            // No man page, return minimal info
            return `${name}: built-in command\n\nNo manual entry. Try: help\n`;
        }
    }
}
