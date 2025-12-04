/**
 * Log a service error.
 *
 * @module kernel/kernel/log-service-error
 */

import type { Kernel } from '../kernel.js';
import { formatError } from './format-error.js';

/**
 * Log a service error.
 *
 * @param self - Kernel instance
 * @param service - Service name
 * @param context - Error context
 * @param err - Error
 */
export function logServiceError(
    self: Kernel,
    service: string,
    context: string,
    err: unknown
): void {
    self.hal.console.error(
        new TextEncoder().encode(`service ${service}: ${context}: ${formatError(err)}\n`)
    );
}
