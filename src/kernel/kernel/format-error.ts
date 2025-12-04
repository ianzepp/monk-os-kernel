/**
 * Format an error for logging.
 *
 * WHY: Consistent error formatting across the kernel. We extract the message
 * from Error objects but handle non-Error throws (which are valid in JS).
 *
 * @module kernel/kernel/format-error
 */

/**
 * Format an error for logging.
 *
 * @param err - Error to format
 * @returns Formatted error message
 */
export function formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
