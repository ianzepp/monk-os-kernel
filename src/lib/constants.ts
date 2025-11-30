/**
 * Application-wide constants
 *
 * Centralized configuration values and limits used throughout the application.
 */

/**
 * Maximum observer recursion depth.
 *
 * Prevents infinite loops from circular observer dependencies.
 *
 * Depth levels:
 * - Level 1: Initial operation (e.g., user creates post)
 * - Level 2: Triggered operation (e.g., post creation triggers notification)
 * - Level 3: Nested operation (e.g., notification triggers audit log)
 *
 * Operations that exceed this depth will throw ObserverRecursionError.
 */
export const SQL_MAX_RECURSION = 3;

/**
 * Default JWT token expiry in seconds (24 hours)
 */
export const JWT_DEFAULT_EXPIRY = 24 * 60 * 60;

/**
 * Sudo token expiry in seconds (15 minutes)
 */
export const JWT_SUDO_EXPIRY = 15 * 60;

/**
 * Fake/impersonation token expiry in seconds (1 hour)
 */
export const JWT_FAKE_EXPIRY = 60 * 60;

/**
 * Get project root directory.
 * Reads from process.env.PROJECT_ROOT at runtime (not module load time).
 */
export function getProjectRoot(): string {
    return process.env.PROJECT_ROOT || process.cwd();
}
