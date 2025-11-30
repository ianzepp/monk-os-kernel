/**
 * Shell Path Utilities
 *
 * Provides path resolution and manipulation for shell commands.
 * Ported from src/lib/tty/parser.ts for use in Monk OS binaries.
 */

/**
 * Normalize path (handle . and ..)
 */
function normalizePath(path: string): string {
    const parts = path.split('/').filter(p => p && p !== '.');
    const result: string[] = [];

    for (const part of parts) {
        if (part === '..') {
            result.pop();
        } else {
            result.push(part);
        }
    }

    return '/' + result.join('/');
}

/**
 * Resolve path relative to current working directory
 *
 * @param cwd - Current working directory
 * @param path - Path to resolve (absolute or relative)
 * @returns Absolute normalized path
 *
 * @example
 * resolvePath('/home/user', 'docs')      // '/home/user/docs'
 * resolvePath('/home/user', '../bin')    // '/home/bin'
 * resolvePath('/home/user', '/etc')      // '/etc'
 * resolvePath('/home/user', '~/docs')    // '/docs' (~ expands to /)
 */
export function resolvePath(cwd: string, path: string): string {
    // Handle home directory (basic ~ expansion)
    if (path.startsWith('~')) {
        path = '/' + path.slice(1);
    }

    // Absolute path
    if (path.startsWith('/')) {
        return normalizePath(path);
    }

    // Relative path
    return normalizePath(cwd + '/' + path);
}

/**
 * Resolve path with home directory from environment
 *
 * @param cwd - Current working directory
 * @param path - Path to resolve
 * @param home - Home directory (from $HOME)
 * @returns Absolute normalized path
 *
 * @example
 * resolvePathWithHome('/tmp', '~/docs', '/home/user')  // '/home/user/docs'
 */
export function resolvePathWithHome(cwd: string, path: string, home: string): string {
    // Handle home directory with actual home path
    if (path === '~') {
        return normalizePath(home);
    }
    if (path.startsWith('~/')) {
        return normalizePath(home + path.slice(1));
    }

    // Absolute path
    if (path.startsWith('/')) {
        return normalizePath(path);
    }

    // Relative path
    return normalizePath(cwd + '/' + path);
}

/**
 * Get the base name of a path (last component)
 *
 * @example
 * basename('/home/user/file.txt')  // 'file.txt'
 * basename('/home/user/')          // 'user'
 * basename('/')                    // ''
 */
export function basename(path: string): string {
    const normalized = normalizePath(path);
    const parts = normalized.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
}

/**
 * Get the directory name of a path (all but last component)
 *
 * @example
 * dirname('/home/user/file.txt')  // '/home/user'
 * dirname('/home/user')           // '/home'
 * dirname('/')                    // '/'
 */
export function dirname(path: string): string {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) return '/';
    return normalized.slice(0, lastSlash);
}

/**
 * Join path segments
 *
 * @example
 * joinPath('/home', 'user', 'docs')  // '/home/user/docs'
 * joinPath('/home', '../etc')        // '/etc'
 */
export function joinPath(...segments: string[]): string {
    return normalizePath(segments.join('/'));
}

/**
 * Check if path is absolute
 */
export function isAbsolute(path: string): boolean {
    return path.startsWith('/');
}
