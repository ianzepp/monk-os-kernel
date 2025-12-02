/**
 * Misc Syscalls
 *
 * Miscellaneous syscalls (getargs, getcwd, chdir, getenv, setenv)
 */

import type { VFS } from '@src/vfs/index.js';
import type { Process } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { SyscallRegistry } from './types.js';

/**
 * Resolve a path relative to cwd if not absolute.
 */
function resolvePath(cwd: string, path: string): string {
    if (path.startsWith('/')) {
        return path;
    }
    // Resolve relative path against cwd
    const baseParts = cwd.split('/').filter(Boolean);
    const relativeParts = path.split('/');

    for (const part of relativeParts) {
        if (part === '.' || part === '') {
            continue;
        } else if (part === '..') {
            baseParts.pop();
        } else {
            baseParts.push(part);
        }
    }

    return '/' + baseParts.join('/');
}

/**
 * Create miscellaneous syscalls.
 *
 * @param vfs - VFS instance for path validation
 */
export function createMiscSyscalls(vfs: VFS): SyscallRegistry {
    return {
        async *getargs(proc: Process): AsyncIterable<Response> {
            yield respond.ok(proc.args);
        },

        async *getcwd(proc: Process): AsyncIterable<Response> {
            yield respond.ok(proc.cwd);
        },

        async *chdir(proc: Process, path: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');
                return;
            }

            // Resolve path relative to cwd
            const resolvedPath = resolvePath(proc.cwd, path);

            // Verify path exists and is a directory
            try {
                const stat = await vfs.stat(resolvedPath, proc.id);
                if (stat.model !== 'folder') {
                    yield respond.error('ENOTDIR', `Not a directory: ${path}`);
                    return;
                }
            } catch (err) {
                // Path doesn't exist or access denied
                const code = (err as { code?: string }).code ?? 'ENOENT';
                const message = (err as Error).message ?? `No such directory: ${path}`;
                yield respond.error(code, message);
                return;
            }

            proc.cwd = resolvedPath;
            yield respond.ok();
        },

        async *getenv(proc: Process, name: unknown): AsyncIterable<Response> {
            if (typeof name !== 'string') {
                yield respond.error('EINVAL', 'name must be a string');
                return;
            }
            yield respond.ok(proc.env[name]);
        },

        async *setenv(proc: Process, name: unknown, value: unknown): AsyncIterable<Response> {
            if (typeof name !== 'string') {
                yield respond.error('EINVAL', 'name must be a string');
                return;
            }
            if (typeof value !== 'string') {
                yield respond.error('EINVAL', 'value must be a string');
                return;
            }
            proc.env[name] = value;
            yield respond.ok();
        },
    };
}
