/**
 * Mount Filesystem Syscall Handler
 *
 * WHY: Implements the mount syscall, allowing processes to attach external
 * filesystems (host directories, s3 buckets, etc.) to the VFS namespace.
 * Enforces mount policy rules to control which processes can mount what.
 *
 * SECURITY MODEL:
 * 1. Policy-based access control (mount policy rules, first match wins)
 * 2. Optional ACL checks on target directory (requireGrant in policy)
 * 3. Deny-by-default (no matching policy rule = EPERM)
 *
 * SUPPORTED MOUNT SOURCES:
 * - host:/path → Host filesystem (via VFS.mountHost)
 * - tmpfs → In-memory filesystem (not yet implemented)
 * - s3://bucket → S3 storage (future)
 * - gcs://bucket → Google Cloud Storage (future)
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
 * ALGORITHM:
 * 1. Find matching policy rule (first match wins)
 * 2. If no rule matches, deny with EPERM
 * 3. If rule has requireGrant, check ACL on target directory
 * 4. Parse source prefix and dispatch to appropriate mount handler
 * 5. Call VFS mount method with parsed parameters
 *
 * SECURITY:
 * - Policy rules checked before any VFS operations
 * - ACL checks use VFS.stat (TODO: needs proper VFS.checkAccess API)
 * - ENOENT on target is acceptable (mount will create it)
 * - EACCES on target triggers EACCES error to caller
 *
 * @param self - Kernel instance
 * @param proc - Calling process
 * @param source - Mount source (e.g., 'host:/path', 's3://bucket', 'tmpfs')
 * @param target - Mount target path (must be absolute VFS path)
 * @param opts - Mount options (source-type specific)
 * @throws EPERM if no policy rule allows the mount
 * @throws EACCES if requireGrant check fails on target
 * @throws ENOTSUP if mount source type is not yet supported
 * @throws EINVAL if mount source type is unknown/malformed
 */
export async function mountFs(
    self: Kernel,
    proc: Process,
    source: string,
    target: string,
    opts?: Record<string, unknown>,
): Promise<void> {
    const caller = proc.id;

    // Step 1: Find matching policy rule
    const rule = findMountPolicyRule(self, caller, source, target);

    if (!rule) {
        printk(self, 'mount', `DENIED: ${caller.slice(0, 8)} mount ${source} -> ${target}`);
        throw new EPERM(`Mount policy denies: ${source} -> ${target}`);
    }

    printk(self, 'mount', `Policy match: ${rule.description ?? 'unnamed rule'}`);

    // Step 2: Check grant if required by policy
    if (rule.requireGrant) {
        try {
            // WHY: VFS.stat checks ACL permissions for caller
            // TODO: This only verifies read access. We need a proper VFS.checkAccess
            // API that accepts specific grant names (e.g., 'mount', 'write').
            await self.vfs.stat(target, caller);
        }
        catch (err) {
            const error = err as Error & { code?: string };

            if (error.code === 'ENOENT') {
                // Target doesn't exist yet - acceptable, mount will create it
            }
            else if (error.code === 'EACCES') {
                // Caller lacks required grant on target
                throw new EACCES(`Mount requires '${rule.requireGrant}' grant on ${target}`);
            }
            // Other errors (EINVAL, etc.) fall through - let VFS handle them
        }
    }

    // Step 3: Parse source prefix and mount
    if (source.startsWith('host:')) {
        // Host filesystem mount
        const hostPath = source.slice(5); // Remove 'host:' prefix

        self.vfs.mountHost(target, hostPath, opts as import('../../vfs/mounts/host.js').HostMountOptions);
        printk(self, 'mount', `Mounted host:${hostPath} -> ${target}`);
    }
    else if (source === 'tmpfs') {
        // tmpfs is not yet supported via syscall
        // WHY: VFS doesn't expose getModel() to external callers. Users should
        // create directories in /tmp instead, which is already tmpfs.
        throw new ENOTSUP('tmpfs mounts not yet supported via syscall');
    }
    else {
        // Future: s3://, gcs://, etc.
        throw new EINVAL(`Unknown mount source type: ${source}`);
    }
}
