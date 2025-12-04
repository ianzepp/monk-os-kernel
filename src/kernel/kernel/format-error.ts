/**
 * Error Formatting Utility
 *
 * WHY: Consistent error formatting across the kernel. JavaScript allows
 * throwing any value (not just Error objects), so we need defensive handling
 * to extract meaningful messages from unknown error types.
 *
 * @module kernel/kernel/format-error
 */

/**
 * Format an error for logging.
 *
 * WHY: Extracts error message from Error objects, but handles non-Error
 * throws gracefully. JavaScript permits `throw "string"` or `throw 42`,
 * so we must convert unknown values to strings safely.
 *
 * @param err - Error to format (unknown type for maximum safety)
 * @returns Formatted error message string
 */
export function formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
