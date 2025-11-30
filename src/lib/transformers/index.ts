/**
 * Transformers
 *
 * Data transformation layer for shaping raw database records into API responses.
 * Sits between the FS layer (raw data) and formatters (serialization).
 *
 * Default behavior:
 * - `id` is always included
 * - stat fields excluded unless ?stat=true
 * - access fields excluded unless ?access=true
 * - select for explicit field projection
 *
 * Usage:
 *   import { transform } from '@src/lib/transformers';
 *
 *   const raw = await fs.read('/api/data/users/123');
 *   const shaped = transform(JSON.parse(raw), { stat: false, access: false });
 */

import {
    type TransformOptions,
    STAT_FIELDS,
    ACCESS_PREFIX,
    ALWAYS_INCLUDED,
} from './types.js';

export type { TransformOptions } from './types.js';
export { STAT_FIELDS, ACCESS_PREFIX, ALWAYS_INCLUDED } from './types.js';

/**
 * Check if a field is a stat field
 */
export function isStatField(field: string): boolean {
    return (STAT_FIELDS as readonly string[]).includes(field);
}

/**
 * Check if a field is an access field
 */
export function isAccessField(field: string): boolean {
    return field.startsWith(ACCESS_PREFIX);
}

/**
 * Check if a field should always be included
 */
export function isAlwaysIncluded(field: string): boolean {
    return (ALWAYS_INCLUDED as readonly string[]).includes(field);
}

/**
 * Transform a single record
 *
 * @param data - Raw record from database
 * @param options - Transform options
 * @returns Transformed record with filtered fields
 */
export function transform<T extends Record<string, unknown>>(
    data: T,
    options: TransformOptions = {}
): Partial<T> {
    const { stat = false, access = false, select } = options;
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
        // Always include certain fields
        if (isAlwaysIncluded(key)) {
            result[key] = value;
            continue;
        }

        // Filter access fields
        if (isAccessField(key) && !access) {
            continue;
        }

        // Filter stat fields
        if (isStatField(key) && !stat) {
            continue;
        }

        // Apply select projection
        if (select && !select.includes(key)) {
            continue;
        }

        result[key] = value;
    }

    return result as Partial<T>;
}

/**
 * Transform an array of records
 *
 * @param data - Array of raw records
 * @param options - Transform options
 * @returns Array of transformed records (primitives pass through unchanged)
 */
export function transformMany<T extends Record<string, unknown>>(
    data: T[],
    options: TransformOptions = {}
): (Partial<T> | T)[] {
    return data.map(record => {
        // Only transform objects, pass through primitives (strings, numbers, etc.)
        if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
            return transform(record, options);
        }
        return record;
    });
}

/**
 * Parse transform options from query parameters
 *
 * Handles URL query params like ?stat=true&access=true&select=id,name,email
 *
 * @param query - Query parameters object
 * @returns Parsed transform options
 */
export function parseTransformOptions(query: Record<string, unknown>): TransformOptions {
    const options: TransformOptions = {};

    // Parse boolean flags
    if (query.stat !== undefined) {
        options.stat = query.stat === 'true' || query.stat === '1';
    }

    if (query.access !== undefined) {
        options.access = query.access === 'true' || query.access === '1';
    }

    // Parse select as comma-separated list
    if (typeof query.select === 'string' && query.select) {
        options.select = query.select.split(',').map(s => s.trim()).filter(Boolean);
    }

    return options;
}
