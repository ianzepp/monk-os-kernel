/**
 * Shell Glob Expansion
 *
 * Provides glob pattern matching and expansion for shell commands.
 * Ported from src/lib/tty/executor.ts for use in Monk OS shell.
 */

import { resolvePath } from './path.js';

/**
 * Check if string contains glob characters
 *
 * @param s - String to check
 * @returns True if contains *, ?, [, or ]
 *
 * @example
 * hasGlobChars('*.txt')     // true
 * hasGlobChars('file.txt')  // false
 */
export function hasGlobChars(s: string): boolean {
    return /[*?[\]]/.test(s);
}

/**
 * Convert glob pattern to regex
 *
 * @param pattern - Glob pattern
 * @returns RegExp that matches the pattern
 *
 * @example
 * globToRegex('*.txt')      // /^.*\.txt$/
 * globToRegex('file?.log')  // /^file.\.log$/
 */
export function globToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
}

/**
 * Match a string against a glob pattern
 *
 * @param pattern - Glob pattern
 * @param str - String to test
 * @returns True if string matches pattern
 *
 * @example
 * matchGlob('*.txt', 'file.txt')  // true
 * matchGlob('*.txt', 'file.log')  // false
 */
export function matchGlob(pattern: string, str: string): boolean {
    return globToRegex(pattern).test(str);
}

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
        if (!hasGlobChars(arg)) {
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
        if (!hasGlobChars(pattern)) {
            result.push(arg);
            continue;
        }

        try {
            const entries = await readdir(dir);
            const regex = globToRegex(pattern);
            const matches = entries
                .filter(e => regex.test(e.name))
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
 *
 * Convenience wrapper for single argument expansion.
 *
 * @param arg - Argument to expand
 * @param cwd - Current working directory
 * @param readdir - Function to read directory entries
 * @returns Expanded arguments (may be multiple)
 */
export async function expandGlob(
    arg: string,
    cwd: string,
    readdir: ReaddirFn
): Promise<string[]> {
    return expandGlobs([arg], cwd, readdir);
}

/**
 * Check if a path matches a glob pattern
 *
 * Supports multi-segment patterns like 'src/*.ts' or '**\/*.js'.
 * Note: ** (globstar) is not yet implemented.
 *
 * @param pattern - Glob pattern
 * @param path - Path to test
 * @returns True if path matches pattern
 */
export function pathMatchesGlob(pattern: string, path: string): boolean {
    // Split both into segments
    const patternParts = pattern.split('/').filter(Boolean);
    const pathParts = path.split('/').filter(Boolean);

    if (patternParts.length !== pathParts.length) {
        return false;
    }

    for (let i = 0; i < patternParts.length; i++) {
        const patternPart = patternParts[i];
        const pathPart = pathParts[i];

        if (hasGlobChars(patternPart)) {
            if (!matchGlob(patternPart, pathPart)) {
                return false;
            }
        } else {
            if (patternPart !== pathPart) {
                return false;
            }
        }
    }

    return true;
}
