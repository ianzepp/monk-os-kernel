/**
 * Boot Sequence
 *
 * Handles the Phase 0 → Phase 1 transition:
 * - Reading ROM files from host filesystem
 * - Copying them into VFS as real entities with UUIDs and ACLs
 */

import { readFile, readdir } from 'fs/promises';
import { join, resolve } from 'path';

/**
 * Dependencies for boot operations
 */
export interface BootDeps {
    vfs: {
        mkdir(path: string, caller: string, opts?: { recursive?: boolean }): Promise<string>;
        setAccess(path: string, caller: string, acl: {
            grants: { to: string; ops: string[] }[];
            deny: string[];
        }): Promise<void>;
        open(path: string, flags: { read?: boolean; write?: boolean; create?: boolean }, caller: string): Promise<{
            write(data: Uint8Array): Promise<number>;
            close(): Promise<void>;
        }>;
    };
}

/**
 * Copy ROM filesystem into VFS.
 *
 * Reads all files from the host ROM directory and creates them
 * as real VFS entities with UUIDs and ACLs.
 *
 * @param deps - VFS dependencies
 * @param romPath - Path to ROM directory on host (e.g., './rom')
 */
export async function copyRomToVfs(deps: BootDeps, romPath: string): Promise<void> {
    const absoluteRomPath = resolve(romPath);
    await copyDirToVfs(deps, absoluteRomPath, '/');
}

/**
 * Recursively copy a host directory into VFS.
 */
async function copyDirToVfs(deps: BootDeps, hostDir: string, vfsDir: string): Promise<void> {
    const { vfs } = deps;
    const entries = await readdir(hostDir, { withFileTypes: true });

    for (const entry of entries) {
        const hostPath = join(hostDir, entry.name);
        const vfsPath = vfsDir === '/' ? `/${entry.name}` : `${vfsDir}/${entry.name}`;

        if (entry.isDirectory()) {
            // Create directory in VFS (recursive: true to handle existing dirs)
            await vfs.mkdir(vfsPath, 'kernel', { recursive: true });

            // Set directory ACL: world-readable
            await vfs.setAccess(vfsPath, 'kernel', {
                grants: [{ to: '*', ops: ['read', 'list', 'stat'] }],
                deny: [],
            });

            // Recurse into subdirectory
            await copyDirToVfs(deps, hostPath, vfsPath);
        } else if (entry.isFile()) {
            // Read file content from host
            const content = await readFile(hostPath);

            // Create file in VFS
            const handle = await vfs.open(
                vfsPath,
                { read: true, write: true, create: true },
                'kernel'
            );

            // Write content
            await handle.write(new Uint8Array(content));
            await handle.close();

            // Set file ACL: world-readable
            await vfs.setAccess(vfsPath, 'kernel', {
                grants: [{ to: '*', ops: ['read', 'stat'] }],
                deny: [],
            });
        }
    }
}
