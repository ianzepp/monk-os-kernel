/**
 * Field Extractor Utility
 *
 * Lightweight field extraction using dot notation, similar to lodash.pick()
 * but without requiring lodash as a dependency.
 *
 * Used internally by fieldExtractionMiddleware to support ?unwrap and ?select= parameters.
 *
 * Supports:
 * - Nested paths: get(obj, 'data.user.email')
 * - Multiple fields: pick(obj, ['data.id', 'data.name'])
 * - Graceful handling: returns null/undefined for missing fields
 */

/**
 * Get a nested field from an object using dot notation
 *
 * @param obj - Source object
 * @param path - Dot-notated path (e.g., 'data.user.email')
 * @returns The value at the path, or undefined if not found
 *
 * @example
 * get({ data: { user: { email: 'test@example.com' } } }, 'data.user.email')
 * // Returns: 'test@example.com'
 */
export function get(obj: any, path: string): any {
    if (!obj || !path) {
        return undefined;
    }

    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
        if (current === null || current === undefined) {
            return undefined;
        }
        current = current[key];
    }

    return current;
}

/**
 * Pick multiple fields from an object using dot notation paths
 *
 * @param obj - Source object
 * @param paths - Array of dot-notated paths
 * @returns New object with only the picked fields (flattened)
 *
 * @example
 * pick({ data: { id: '123', name: 'Test', email: 'test@example.com' } }, ['data.id', 'data.name'])
 * // Returns: { id: '123', name: 'Test' }
 */
export function pick(obj: any, paths: string[]): any {
    if (!obj || !paths || paths.length === 0) {
        return {};
    }

    const result: any = {};

    for (const path of paths) {
        const value = get(obj, path);

        // Extract the last segment of the path as the key
        // 'data.user.email' → 'email'
        const key = path.split('.').pop() || path;

        result[key] = value;
    }

    return result;
}

/**
 * Extract fields from an object based on comma-separated paths
 *
 * @param obj - Source object
 * @param pathsString - Comma-separated paths (e.g., 'data.id,data.name')
 * @returns Extracted value(s) - scalar for single path, object for multiple
 *
 * @example
 * extract(response, 'data.id')
 * // Returns: '123' (scalar value)
 *
 * extract(response, 'data.id,data.name')
 * // Returns: { id: '123', name: 'Test' } (object)
 */
export function extract(obj: any, pathsString: string): any {
    if (!pathsString || pathsString.trim() === '') {
        return obj;
    }

    const paths = pathsString.split(',').map(p => p.trim()).filter(p => p);

    if (paths.length === 0) {
        return obj;
    }

    // Single path: return scalar value
    if (paths.length === 1) {
        return get(obj, paths[0]);
    }

    // Multiple paths: return object with picked fields
    return pick(obj, paths);
}
