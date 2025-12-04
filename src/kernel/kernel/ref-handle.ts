/**
 * Increment reference count for a handle.
 *
 * INVARIANT: Handle must exist in handles map.
 *
 * @module kernel/kernel/ref-handle
 */

import type { Kernel } from '../kernel.js';

/**
 * Increment reference count for a handle.
 *
 * @param self - Kernel instance
 * @param handleId - Handle ID to reference
 */
export function refHandle(self: Kernel, handleId: string): void {
    const refs = self.handleRefs.get(handleId) ?? 1;
    self.handleRefs.set(handleId, refs + 1);
}
