/**
 * Glob Pattern Matching for VFS Scripts
 *
 * Minimatch-inspired glob patterns. Pure functions, no I/O.
 */

export interface GlobOptions {
    /** Match dotfiles with * and ** */
    dot?: boolean;
    /** Case-insensitive matching */
    nocase?: boolean;
    /** Treat backslash as literal (not escape) */
    noescape?: boolean;
}

/**
 * Test if a path matches a glob pattern.
 *
 *     match('src/foo.ts', '*.ts')           // false (no path sep in *)
 *     match('src/foo.ts', '**\/*.ts')        // true
 *     match('src/foo.ts', 'src/*.ts')       // true
 *     match('.hidden', '*', { dot: true })  // true
 */
export function match(path: string, pattern: string, options: GlobOptions = {}): boolean {
    const regex = toRegex(pattern, options);
    return regex.test(path);
}

/**
 * Filter paths that match a glob pattern.
 *
 *     filter(['a.ts', 'b.js', 'c.ts'], '*.ts')  // ['a.ts', 'c.ts']
 */
export function filter(paths: string[], pattern: string, options: GlobOptions = {}): string[] {
    const regex = toRegex(pattern, options);
    return paths.filter(p => regex.test(p));
}

/**
 * Create a matcher function for a pattern.
 *
 *     const isTs = matcher('**\/*.ts')
 *     isTs('src/foo.ts')  // true
 */
export function matcher(pattern: string, options: GlobOptions = {}): (path: string) => boolean {
    const regex = toRegex(pattern, options);
    return (path: string) => regex.test(path);
}

/**
 * Convert a glob pattern to a RegExp.
 */
export function toRegex(pattern: string, options: GlobOptions = {}): RegExp {
    const { dot = false, nocase = false, noescape = false } = options;

    let regex = '';
    let inBracket = false;
    let i = 0;

    while (i < pattern.length) {
        const char = pattern[i];
        const next = pattern[i + 1];

        // Escape sequences
        if (!noescape && char === '\\' && next) {
            regex += escapeRegex(next);
            i += 2;
            continue;
        }

        // Character classes [...]
        if (char === '[') {
            inBracket = true;
            regex += '[';
            // Handle negation [!...] -> [^...]
            if (pattern[i + 1] === '!' || pattern[i + 1] === '^') {
                regex += '^';
                i++;
            }
            i++;
            continue;
        }

        if (char === ']' && inBracket) {
            inBracket = false;
            regex += ']';
            i++;
            continue;
        }

        // Inside bracket, mostly literal
        if (inBracket) {
            if (char === '\\' && !noescape && pattern[i + 1]) {
                regex += escapeRegex(pattern[i + 1]);
                i += 2;
            } else {
                regex += char === '-' ? '-' : escapeRegex(char);
                i++;
            }
            continue;
        }

        // Globstar **
        if (char === '*' && next === '*') {
            // ** matches everything including /
            // Check if it's a proper /**/ or **/ or /** pattern
            const prev = pattern[i - 1];
            const afterNext = pattern[i + 2];

            if ((prev === '/' || i === 0) && (afterNext === '/' || afterNext === undefined)) {
                // Proper globstar
                if (afterNext === '/') {
                    // **/ - match any path prefix
                    regex += dot ? '(?:.*/)?' : '(?:(?:[^./][^/]*|\\.[^./][^/]*)/)*';
                    i += 3;
                } else {
                    // ** at end - match anything
                    regex += dot ? '.*' : '(?:[^./].*)?';
                    i += 2;
                }
            } else {
                // Not a proper globstar, treat as two *
                regex += dot ? '[^/]*[^/]*' : '[^/]*[^/]*';
                i += 2;
            }
            continue;
        }

        // Single * - matches anything except /
        if (char === '*') {
            if (dot) {
                regex += '[^/]*';
            } else {
                // Don't match dotfiles at start of segment
                const prev = pattern[i - 1];
                if (prev === '/' || i === 0) {
                    regex += '(?:[^./][^/]*)?';
                } else {
                    regex += '[^/]*';
                }
            }
            i++;
            continue;
        }

        // ? - matches any single character except /
        if (char === '?') {
            if (dot) {
                regex += '[^/]';
            } else {
                const prev = pattern[i - 1];
                if (prev === '/' || i === 0) {
                    regex += '[^./]';
                } else {
                    regex += '[^/]';
                }
            }
            i++;
            continue;
        }

        // Literal characters
        regex += escapeRegex(char);
        i++;
    }

    const flags = nocase ? 'i' : '';
    return new RegExp(`^${regex}$`, flags);
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a pattern contains glob special characters.
 */
export function isGlob(pattern: string): boolean {
    // Look for unescaped glob characters
    let i = 0;
    while (i < pattern.length) {
        const char = pattern[i];
        if (char === '\\') {
            i += 2; // Skip escaped char
            continue;
        }
        if (char === '*' || char === '?' || char === '[') {
            return true;
        }
        i++;
    }
    return false;
}

/**
 * Get the non-glob prefix of a pattern.
 *
 *     base('src/**\/*.ts')  // 'src'
 *     base('*.ts')         // ''
 */
export function base(pattern: string): string {
    const parts = pattern.split('/');
    const baseParts: string[] = [];

    for (const part of parts) {
        if (isGlob(part)) break;
        baseParts.push(part);
    }

    return baseParts.join('/');
}
