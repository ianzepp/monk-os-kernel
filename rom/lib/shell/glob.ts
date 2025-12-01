/**
 * Shell Glob Expansion
 *
 * Filesystem-integrated glob expansion for shell commands.
 * Uses /lib/glob for pattern matching.
 */

import { resolvePath } from '/lib/path';
import { match, isGlob } from '/lib/glob';

/**
 * Directory entry for glob expansion
 */
export interface GlobEntry {
    name: string;
    isDirectory: boolean;
}

/**
 * Function type for reading directory entries
 */
export type ReaddirFn = (path: string) => Promise<GlobEntry[]>;

/**
 * Expand glob patterns in arguments
 *
 * Takes an array of arguments and expands any glob patterns
 * by listing the directory and matching filenames.
 *
 * @param args - Arguments to expand
 * @param cwd - Current working directory
 * @param readdir - Function to read directory entries
 * @returns Expanded arguments
 *
 * @example
 * // With files: foo.txt, bar.txt, baz.log
 * await expandGlobs(['*.txt'], '/home', readdir)
 * // Returns: ['bar.txt', 'foo.txt']
 */
export async function expandGlobs(
    args: string[],
    cwd: string,
    readdir: ReaddirFn
): Promise<string[]> {
    const result: string[] = [];

    for (const arg of args) {
        if (!isGlob(arg)) {
            result.push(arg);
            continue;
        }

        const lastSlash = arg.lastIndexOf('/');
        let dir: string;
        let pattern: string;

        if (lastSlash === -1) {
            // No slash: glob in cwd
            dir = cwd;
            pattern = arg;
        } else if (lastSlash === 0) {
            // Leading slash: glob in root
            dir = '/';
            pattern = arg.slice(1);
        } else {
            // Path with directory: resolve and glob
            dir = resolvePath(cwd, arg.slice(0, lastSlash));
            pattern = arg.slice(lastSlash + 1);
        }

        // If no glob in the filename part, keep as-is
        if (!isGlob(pattern)) {
            result.push(arg);
            continue;
        }

        try {
            const entries = await readdir(dir);
            const matches = entries
                .filter(e => match(e.name, pattern))
                .map(e => {
                    const path = dir === cwd ? e.name : `${dir}/${e.name}`;
                    return e.isDirectory ? path + '/' : path;
                })
                .sort();

            if (matches.length > 0) {
                result.push(...matches);
            } else {
                // No matches: keep literal (bash behavior)
                result.push(arg);
            }
        } catch {
            // Error reading directory: keep literal
            result.push(arg);
        }
    }

    return result;
}

/**
 * Expand glob patterns in a single argument
 */
export async function expandGlob(
    arg: string,
    cwd: string,
    readdir: ReaddirFn
): Promise<string[]> {
    return expandGlobs([arg], cwd, readdir);
}
