/**
 * Kernel debug logging (like Linux printk).
 *
 * WHY: Kernel-level debugging separate from application logging.
 * Only outputs when debug mode is enabled via boot flag.
 * Output goes directly to console, not through logd.
 *
 * @module kernel/kernel/printk
 */

import type { Kernel } from '../kernel.js';

/**
 * Log a kernel debug message.
 *
 * @param self - Kernel instance
 * @param category - Logging category (e.g., 'syscall', 'spawn', 'cleanup')
 * @param message - Log message
 */
export function printk(self: Kernel, category: string, message: string): void {
    if (self.debugEnabled) {
        console.log(`[kernel:${category}] ${message}`);
    }
}
