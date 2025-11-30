/**
 * umount - Unmount a filesystem
 *
 * Usage:
 *   umount <mountpoint>
 *
 * Removes the mount from the current session and from ~/.config/mounts.json
 * so it won't be restored on next login.
 *
 * Examples:
 *   umount /dist
 *   umount /projects
 *   umount /home/root/rich
 */

import { resolvePath } from '../parser.js';
import { removeMountConfig } from '../profile.js';
import type { CommandHandler } from './shared.js';

export const umount: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('umount: filesystem not available\n');
        return 1;
    }

    if (args.length === 0) {
        io.stderr.write('umount: missing mountpoint\n');
        io.stderr.write('Usage: umount <mountpoint>\n');
        return 1;
    }

    const target = args[0];
    const virtualPath = resolvePath(session.cwd, target);

    // Check if this is a user mount (session mount)
    const isUserMount = session.mounts.has(virtualPath);

    // Check if mount exists in FS
    const mounts = fs.getMounts();
    if (!mounts.has(virtualPath) && !isUserMount) {
        io.stderr.write(`umount: ${virtualPath}: not mounted\n`);
        return 1;
    }

    try {
        // Unmount from FS if present
        if (mounts.has(virtualPath)) {
            fs.unmount(virtualPath);
        }

        // Remove from session mounts
        session.mounts.delete(virtualPath);

        // Remove from saved mounts file
        await removeMountConfig(session, virtualPath);

        io.stdout.write(`Unmounted ${virtualPath}\n`);
        return 0;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        io.stderr.write(`umount: ${message}\n`);
        return 1;
    }
};
