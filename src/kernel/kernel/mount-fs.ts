/**
 * Mount a source to a target path (syscall handler).
 *
 * ALGORITHM:
 * 1. Find matching policy rule
 * 2. If no rule matches, deny (EPERM)
 * 3. If rule has requireGrant, check ACL on target
 * 4. Resolve source to model and mount
 *
 * @module kernel/kernel/mount-fs
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EPERM, EACCES, ENOTSUP, EINVAL } from '../errors.js';
import { findMountPolicyRule } from './find-mount-policy-rule.js';
import { printk } from './printk.js';

/**
 * Mount a source to a target path.
 *
 * @param self - Kernel instance
 * @param proc - Calling process
 * @param source - Mount source (e.g., 'host:/path', 's3://bucket')
 * @param target - Mount target path
 * @param opts - Mount options
 * @throws EPERM if no policy rule allows the mount
 * @throws EACCES if requireGrant check fails
 */
export async function mountFs(
    self: Kernel,
    proc: Process,
    source: string,
    target: string,
    opts?: Record<string, unknown>
): Promise<void> {
    const caller = proc.id;

    // Find matching policy rule
    const rule = findMountPolicyRule(self, caller, source, target);
    if (!rule) {
        printk(self, 'mount', `DENIED: ${caller.slice(0, 8)} mount ${source} -> ${target}`);
        throw new EPERM(`Mount policy denies: ${source} -> ${target}`);
    }

    printk(self, 'mount', `Policy match: ${rule.description ?? 'unnamed rule'}`);

    // Check grant if required
    if (rule.requireGrant) {
        try {
            // Check if caller has required grant on target directory
            // This uses VFS ACL system
            await self.vfs.stat(target, caller);
            // TODO: Need proper ACL check for specific grant, not just stat
            // For now, stat success means read access, which is insufficient
            // This is a placeholder until VFS.checkAccess is exposed
        } catch (err) {
            const error = err as Error & { code?: string };
            if (error.code === 'ENOENT') {
                // Target doesn't exist - that's ok, we'll create it
            } else if (error.code === 'EACCES') {
                throw new EACCES(`Mount requires '${rule.requireGrant}' grant on ${target}`);
            }
        }
    }

    // Parse source and mount
    if (source.startsWith('host:')) {
        const hostPath = source.slice(5); // Remove 'host:' prefix
        self.vfs.mountHost(target, hostPath, opts as import('../../vfs/mounts/host.js').HostMountOptions);
        printk(self, 'mount', `Mounted host:${hostPath} -> ${target}`);
    } else if (source === 'tmpfs') {
        // tmpfs is not yet supported via syscall - VFS doesn't expose getModel
        // For now, throw ENOTSUP. Users can create directories in /tmp instead.
        throw new ENOTSUP('tmpfs mounts not yet supported via syscall');
    } else {
        // Future: s3://, gcs://, etc.
        throw new EINVAL(`Unknown mount source type: ${source}`);
    }
}
