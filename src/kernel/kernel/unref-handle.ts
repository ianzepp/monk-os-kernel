/**
 * Decrement reference count, closing if last reference.
 *
 * DESIGN: Close is async but we don't await it here.
 * Failure is logged but doesn't prevent other cleanup.
 *
 * @module kernel/kernel/unref-handle
 */

import type { Kernel } from '../kernel.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

/**
 * Decrement reference count, closing handle if last reference.
 *
 * @param self - Kernel instance
 * @param handleId - Handle ID to unreference
 */
export function unrefHandle(self: Kernel, handleId: string): void {
    const refs = (self.handleRefs.get(handleId) ?? 1) - 1;

    if (refs <= 0) {
        const handle = self.handles.get(handleId);
        if (handle) {
            handle.close().catch((err) => {
                printk(self, 'cleanup', `handle ${handleId} close failed: ${formatError(err)}`);
            });
            self.handles.delete(handleId);
        }
        self.handleRefs.delete(handleId);
    } else {
        self.handleRefs.set(handleId, refs);
    }
}
