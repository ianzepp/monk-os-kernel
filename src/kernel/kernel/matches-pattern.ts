/**
 * Glob-Like Pattern Matching
 *
 * WHY: Used by mount policy rules to match paths and sources. Supports simple
 * glob syntax compatible with mount policy configuration files. Intentionally
 * minimal - full glob support lives in rom/lib/glob.ts for userspace.
 *
 * PATTERN SYNTAX:
 * - '*' matches any single path component (e.g., /foo/* matches /foo/bar but not /foo/bar/baz)
 * - '**' matches any number of path components (e.g., /foo/** matches /foo/bar/baz)
 * - Exact string match otherwise
 *
 * @module kernel/kernel/matches-pattern
 */

/**
 * Match a value against a glob-like pattern.
 *
 * ALGORITHM:
 * 1. Fast path: check for exact match or wildcard-all ('*', '**', exact value)
 * 2. Convert glob syntax to regex: ** → .*, * → [^/]*
 * 3. Anchor regex with ^ and $ for full match
 * 4. Test value against generated regex
 *
 * WHY: Two-pass replacement ensures '**' doesn't get mangled by '*' replacement.
 * We use a placeholder (<<<GLOBSTAR>>>) to protect '**' during transformation.
 *
 * @param pattern - Pattern to match against (glob-like syntax)
 * @param value - Value to test
 * @returns True if value matches pattern
 */
export function matchesPattern(pattern: string, value: string): boolean {
    // Fast path: exact match or wildcard all
    if (pattern === '*' || pattern === '**' || pattern === value) {
        return true;
    }

    // Convert glob pattern to regex
    // WHY: Two-pass replacement prevents '**' from being split by '*' replacement
    const regexStr = pattern
        .replace(/\*\*/g, '<<<GLOBSTAR>>>')  // Protect ** during transformation
        .replace(/\*/g, '[^/]*')              // * matches within path component
        .replace(/<<<GLOBSTAR>>>/g, '.*');    // ** matches across components

    const regex = new RegExp(`^${regexStr}$`);

    return regex.test(value);
}
