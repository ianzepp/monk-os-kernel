// Path utilities for userspace

export function dirname(path: string): string {
    if (!path || path === '/') return '/';
    const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) return '.';
    if (lastSlash === 0) return '/';
    return normalized.slice(0, lastSlash);
}

export function basename(path: string): string {
    if (!path || path === '/') return '';
    const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

export function resolvePath(base: string, relative: string): string {
    // Absolute path - return as-is
    if (relative.startsWith('/')) return normalize(relative);

    // Relative path - combine with base
    const combined = base.endsWith('/') ? base + relative : base + '/' + relative;
    return normalize(combined);
}

export function normalize(path: string): string {
    if (!path) return '.';

    const isAbsolute = path.startsWith('/');
    const parts = path.split('/').filter(Boolean);
    const result: string[] = [];

    for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') {
            if (result.length > 0 && result[result.length - 1] !== '..') {
                result.pop();
            }
            else if (!isAbsolute) {
                result.push('..');
            }
        }
        else {
            result.push(part);
        }
    }

    const normalized = result.join('/');
    return isAbsolute ? '/' + normalized : normalized || '.';
}

export function join(...paths: string[]): string {
    return normalize(paths.filter(Boolean).join('/'));
}
