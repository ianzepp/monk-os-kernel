/**
 * Match a value against a glob-like pattern.
 *
 * Supports:
 * - '*' matches any single path component
 * - '**' matches any number of path components
 * - Exact match
 *
 * @module kernel/kernel/matches-pattern
 */

/**
 * Match a value against a glob-like pattern.
 *
 * @param pattern - Pattern to match against
 * @param value - Value to match
 * @returns True if matches
 */
export function matchesPattern(pattern: string, value: string): boolean {
    // Exact match or wildcard all
    if (pattern === '*' || pattern === '**' || pattern === value) {
        return true;
    }

    // Simple glob matching
    // Convert pattern to regex
    const regexStr = pattern
        .replace(/\*\*/g, '<<<GLOBSTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<GLOBSTAR>>>/g, '.*');

    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(value);
}
