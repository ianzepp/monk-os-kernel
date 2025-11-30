/**
 * Transformer Types
 *
 * Defines interfaces for the data transformation layer.
 * Transformers shape raw database records for API responses.
 */

/**
 * Options for transforming data
 *
 * Controls which fields are included in the output:
 * - `id` is always included
 * - stat fields (created_at, updated_at, etc.) excluded by default
 * - access fields (access_full, access_edit, etc.) excluded by default
 * - select for explicit field projection
 */
export interface TransformOptions {
    /**
     * Include stat fields: created_at, updated_at, trashed_at, deleted_at
     * @default false
     */
    stat?: boolean;

    /**
     * Include access fields: access_full, access_edit, access_read, etc.
     * @default false
     */
    access?: boolean;

    /**
     * Field projection - only include these fields (id is always included)
     * If not specified, all non-filtered fields are included
     */
    select?: string[];
}

/**
 * Stat fields that are excluded by default
 */
export const STAT_FIELDS = [
    'created_at',
    'updated_at',
    'trashed_at',
    'deleted_at',
] as const;

/**
 * Prefix for access control fields
 */
export const ACCESS_PREFIX = 'access_';

/**
 * Fields that are always included regardless of options
 */
export const ALWAYS_INCLUDED = ['id'] as const;
