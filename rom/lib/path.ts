/**
 * Path Library for VFS Scripts
 *
 * Pure string manipulation for POSIX paths. No I/O, no syscalls.
 */

/**
 * Join path segments into a single path.
 */
export function join(...segments: string[]): string {
    const joined = segments
        .filter(s => s.length > 0)
        .join('/');
    return normalize(joined);
}

/**
 * Get the directory portion of a path.
 */
export function dirname(path: string): string {
    if (path === '') return '.';
    if (path === '/') return '/';

    // Remove trailing slashes
    const normalized = path.replace(/\/+$/, '');
    const lastSlash = normalized.lastIndexOf('/');

    if (lastSlash === -1) return '.';
    if (lastSlash === 0) return '/';

    return normalized.slice(0, lastSlash);
}

/**
 * Get the filename portion of a path.
 */
export function basename(path: string, ext?: string): string {
    if (path === '') return '';
    if (path === '/') return '';

    // Remove trailing slashes
    const normalized = path.replace(/\/+$/, '');
    const lastSlash = normalized.lastIndexOf('/');
    const base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);

    // Remove extension if specified
    if (ext && base.endsWith(ext)) {
        return base.slice(0, -ext.length);
    }

    return base;
}

/**
 * Get the file extension (including the dot).
 */
export function extname(path: string): string {
    const base = basename(path);
    const dotIndex = base.lastIndexOf('.');

    // No dot, or dot at start (hidden file), or dot at end
    if (dotIndex <= 0 || dotIndex === base.length - 1) {
        return '';
    }

    return base.slice(dotIndex);
}

/**
 * Normalize a path, resolving . and .. segments.
 */
export function normalize(path: string): string {
    if (path === '') return '.';

    const isAbs = path.startsWith('/');
    const segments = path.split('/').filter(s => s.length > 0);
    const result: string[] = [];

    for (const segment of segments) {
        if (segment === '.') {
            continue;
        } else if (segment === '..') {
            if (result.length > 0 && result[result.length - 1] !== '..') {
                result.pop();
            } else if (!isAbs) {
                result.push('..');
            }
            // For absolute paths, ignore .. at root
        } else {
            result.push(segment);
        }
    }

    if (isAbs) {
        return '/' + result.join('/');
    }

    return result.length > 0 ? result.join('/') : '.';
}

/**
 * Check if a path is absolute.
 */
export function isAbsolute(path: string): boolean {
    return path.startsWith('/');
}

/**
 * Resolve a path relative to a base directory.
 * If path is absolute, returns normalized path.
 * If path is relative, joins with base and normalizes.
 */
export function resolve(base: string, path: string): string {
    if (isAbsolute(path)) {
        return normalize(path);
    }
    return normalize(join(base, path));
}

/**
 * Get the relative path from 'from' to 'to'.
 */
export function relative(from: string, to: string): string {
    const fromParts = normalize(from).split('/').filter(s => s.length > 0);
    const toParts = normalize(to).split('/').filter(s => s.length > 0);

    // Find common prefix
    let commonLength = 0;
    const minLength = Math.min(fromParts.length, toParts.length);

    while (commonLength < minLength && fromParts[commonLength] === toParts[commonLength]) {
        commonLength++;
    }

    // Build relative path
    const ups = fromParts.length - commonLength;
    const result: string[] = [];

    for (let i = 0; i < ups; i++) {
        result.push('..');
    }

    for (let i = commonLength; i < toParts.length; i++) {
        result.push(toParts[i]);
    }

    return result.length > 0 ? result.join('/') : '.';
}

/**
 * Parsed path components.
 */
export interface ParsedPath {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
}

/**
 * Parse a path into its components.
 */
export function parse(path: string): ParsedPath {
    const root = isAbsolute(path) ? '/' : '';
    const dir = dirname(path);
    const base = basename(path);
    const ext = extname(path);
    const name = ext ? base.slice(0, -ext.length) : base;

    return { root, dir, base, ext, name };
}

/**
 * Format a parsed path back into a string.
 */
export function format(parsed: Partial<ParsedPath>): string {
    const dir = parsed.dir ?? '';
    const base = parsed.base ?? (parsed.name ?? '') + (parsed.ext ?? '');

    if (dir === '') return base;
    if (dir === '/') return '/' + base;
    return dir + '/' + base;
}
