/**
 * Load services from /etc/services and package directories.
 *
 * @module kernel/kernel/load-services
 */

import type { Kernel } from '../kernel.js';
import { loadServicesFromDir } from './load-services-from-dir.js';

/**
 * Load services from /etc/services and package directories.
 *
 * @param self - Kernel instance
 */
export async function loadServices(self: Kernel): Promise<void> {
    const serviceDirs: string[] = [];

    // Core services
    try {
        await self.vfs.stat('/etc/services', 'kernel');
        serviceDirs.push('/etc/services');
    }
    catch {
        try {
            await self.vfs.mkdir('/etc/services', 'kernel', { recursive: true });
        }
        catch (mkdirErr) {
            // EDGE: May exist from previous boot but stat failed due to cache miss
            if ((mkdirErr as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw mkdirErr;
            }
        }
        serviceDirs.push('/etc/services');
    }

    // Package services
    try {
        await self.vfs.stat('/usr', 'kernel');
        for await (const pkg of self.vfs.readdir('/usr', 'kernel')) {
            if (pkg.model !== 'folder') {
                continue;
            }

            const pkgServicesDir = `/usr/${pkg.name}/etc/services`;

            try {
                await self.vfs.stat(pkgServicesDir, 'kernel');
                serviceDirs.push(pkgServicesDir);
            }
            catch {
                // No services - fine
            }
        }
    }
    catch {
        // No /usr - fine
    }

    // Load from all directories
    for (const dir of serviceDirs) {
        await loadServicesFromDir(self, dir);
    }
}
