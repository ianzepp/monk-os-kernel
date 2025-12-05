/**
 * Unmount Filesystem Syscall Handler
 *
 * WHY: Implements the umount syscall, allowing processes to detach filesystems
 * from the VFS namespace. Uses the same policy rules as mount (if you can mount,
 * you can unmount).
 *
 * SECURITY MODEL:
 * - Same policy rules as mount (reuses findMountPolicyRule)
 * - Source is '*' (wildcard) since we don't track what was originally mounted
 * - Policy checks target path only
 *
 * INVARIANT: VFS.unmount and VFS.unmountHost are idempotent
 * VIOLATED BY: VFS throwing errors for non-existent mounts (would break cleanup)
 *
 * @module kernel/kernel/umount-fs
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EPERM } from '../errors.js';
import { findMountPolicyRule } from './find-mount-policy-rule.js';
import { printk } from './printk.js';

/**
 * Unmount a filesystem at a target path.
 *
 * ALGORITHM:
 * 1. Find matching policy rule (source='*', check target only)
 * 2. If no rule matches, deny with EPERM
 * 3. Call both VFS.unmount and VFS.unmountHost (one will succeed)
 * 4. Log successful unmount
 *
 * WHY: We call both unmount methods because VFS maintains separate mount tables
 * for model mounts (VFS.unmount) and host mounts (VFS.unmountHost). At most one
 * will have an entry for the target path. Both are idempotent, so calling both
 * is safe.
 *
 * SECURITY: Uses same policy as mount. If a process can mount a path, it can
 * unmount it. Source pattern is '*' because we don't track the original mount
 * source in the mount table.
 *
 * @param self - Kernel instance
 * @param proc - Calling process
 * @param target - Path to unmount (must be absolute VFS path)
 * @throws EPERM if no policy rule allows the unmount
 * @throws EINVAL if target is not mounted (from VFS)
 */
export async function umountFs(
    self: Kernel,
    proc: Process,
    target: string,
): Promise<void> {
    const caller = proc.id;

    // Step 1: Check policy (reuse mount policy with wildcard source)
    // WHY: If you can mount, you can unmount. We don't track original source,
    // so we use '*' as a wildcard that matches any source pattern.
    const rule = findMountPolicyRule(self, caller, '*', target);

    if (!rule) {
        printk(self, 'mount', `DENIED: ${caller.slice(0, 8)} umount ${target}`);
        throw new EPERM(`Mount policy denies umount: ${target}`);
    }

    // Step 2: Unmount from VFS (try both mount tables)
    // WHY: VFS has separate tables for model mounts and host mounts.
    // We don't know which table holds this mount, so we try both.
    // Both methods are idempotent (no-op if mount doesn't exist).
    self.vfs.unmount(target);
    self.vfs.unmountHost(target);

    printk(self, 'mount', `Unmounted ${target}`);
}
