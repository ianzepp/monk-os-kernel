/**
 * Service Error Logger - Utility for logging service-related errors
 *
 * This is a simple utility function that logs service errors to the kernel
 * console. It formats errors consistently with service name and context,
 * making it easy to diagnose service failures during boot and runtime.
 *
 * WHY: Centralized error logging for services ensures consistent format
 *      and makes it easy to redirect service errors to syslog/monitoring
 *
 * @module kernel/kernel/log-service-error
 */

import type { Kernel } from '../kernel.js';
import { formatError } from './format-error.js';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Log a service error to the kernel console.
 *
 * @param self - Kernel instance
 * @param service - Service name
 * @param context - Error context (e.g., 'spawn failed', 'load failed')
 * @param err - Error object or value
 */
export function logServiceError(
    self: Kernel,
    service: string,
    context: string,
    err: unknown,
): void {
    // WHY: Format as "service {name}: {context}: {error}"
    //      Consistent format makes parsing logs easier
    self.hal.console.error(
        new TextEncoder().encode(`service ${service}: ${context}: ${formatError(err)}\n`),
    );
}
