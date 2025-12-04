/**
 * Unmount a path (syscall handler).
 *
 * @module kernel/kernel/umount-fs
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EPERM } from '../errors.js';
import { findMountPolicyRule } from './find-mount-policy-rule.js';
import { printk } from './printk.js';

/**
 * Unmount a path.
 *
 * @param self - Kernel instance
 * @param proc - Calling process
 * @param target - Path to unmount
 * @throws EPERM if no policy rule allows the unmount
 * @throws EINVAL if target is not mounted
 */
export async function umountFs(
    self: Kernel,
    proc: Process,
    target: string
): Promise<void> {
    const caller = proc.id;

    // Use same policy check as mount (if you can mount, you can unmount)
    // Source is '*' for unmount since we don't know what was mounted
    const rule = findMountPolicyRule(self, caller, '*', target);
    if (!rule) {
        printk(self, 'mount', `DENIED: ${caller.slice(0, 8)} umount ${target}`);
        throw new EPERM(`Mount policy denies umount: ${target}`);
    }

    // Try to unmount (VFS handles the actual unmount)
    self.vfs.unmount(target);
    self.vfs.unmountHost(target);

    printk(self, 'mount', `Unmounted ${target}`);
}
