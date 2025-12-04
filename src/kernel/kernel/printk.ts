/**
 * Kernel Debug Logging (printk)
 *
 * WHY: Kernel-level debugging separate from application logging. Named after
 * Linux kernel's printk() function. Only outputs when debug mode is enabled
 * via boot flag. Output goes directly to console, bypassing the normal logd
 * service to avoid circular dependencies during kernel initialization.
 *
 * @module kernel/kernel/printk
 */

import type { Kernel } from '../kernel.js';

/**
 * Log a kernel debug message.
 *
 * WHY: Provides categorized debug output for kernel operations. Only logs
 * when Kernel.debugEnabled is true, allowing production deployments to
 * skip debug overhead entirely.
 *
 * @param self - Kernel instance
 * @param category - Logging category (e.g., 'syscall', 'spawn', 'cleanup', 'mount')
 * @param message - Log message
 */
export function printk(self: Kernel, category: string, message: string): void {
    if (self.debugEnabled) {
        console.log(`[kernel:${category}] ${message}`);
    }
}
