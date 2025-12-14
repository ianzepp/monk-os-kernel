/**
 * Load services from /etc/services, /usr, and /app directories.
 *
 * Service discovery order:
 * 1. /etc/services/*.json - core system services
 * 2. /usr/{pkg}/etc/services/*.json - package services
 * 3. /app/{name}/service.json - app services
 *
 * @module kernel/kernel/load-services
 */

import type { Kernel } from '../kernel.js';
import type { ServiceDef } from '../services.js';
import { loadServicesFromDir } from './load-services-from-dir.js';
import { logServiceError } from './log-service-error.js';

/**
 * Load services from /etc/services, /usr, and /app directories.
 *
 * @param self - Kernel instance
 */
export async function loadServices(self: Kernel): Promise<void> {
    const serviceDirs: string[] = [];

    // Core services (/etc/services/*.json)
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

    // Package services (/usr/{pkg}/etc/services/*.json)
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

    // Load from /etc and /usr directories
    for (const dir of serviceDirs) {
        await loadServicesFromDir(self, dir);
    }

    // App services (/app/{name}/service.json)
    await loadAppServices(self);
}

/**
 * Load app services from /app/{name}/service.json.
 *
 * Each app directory can contain a service.json file that registers
 * the app as a service. Handler paths are resolved relative to the
 * app directory (e.g., "main.ts" becomes "/app/{name}/main.ts").
 *
 * @param self - Kernel instance
 */
async function loadAppServices(self: Kernel): Promise<void> {
    // Check if /app exists
    try {
        await self.vfs.stat('/app', 'kernel');
    }
    catch {
        // No /app directory - fine
        return;
    }

    // Iterate over app directories
    for await (const entry of self.vfs.readdir('/app', 'kernel')) {
        if (entry.model !== 'folder') {
            continue;
        }

        const appName = entry.name;
        const appDir = `/app/${appName}`;
        const servicePath = `${appDir}/service.json`;

        // Skip if service already registered (allows /etc/services to override)
        if (self.services.has(appName)) {
            continue;
        }

        // Check if service.json exists
        try {
            await self.vfs.stat(servicePath, 'kernel');
        }
        catch {
            // No service.json - app not registered as service
            continue;
        }

        try {
            // Read service.json
            const handle = await self.vfs.open(servicePath, { read: true }, 'kernel');
            const chunks: Uint8Array[] = [];

            while (true) {
                const chunk = await handle.read(65536);

                if (chunk.length === 0) {
                    break;
                }

                chunks.push(chunk);
            }

            await handle.close();

            // Parse JSON
            const total = chunks.reduce((sum, c) => sum + c.length, 0);
            const combined = new Uint8Array(total);
            let offset = 0;

            for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }

            const content = new TextDecoder().decode(combined);
            const def = JSON.parse(content) as ServiceDef;

            // Resolve relative handler path to absolute
            if (!def.handler.startsWith('/')) {
                def.handler = `${appDir}/${def.handler}`;
            }

            // Validate handler exists
            const handlerPath = def.handler.endsWith('.ts') ? def.handler : def.handler + '.ts';

            try {
                await self.vfs.stat(handlerPath, 'kernel');
            }
            catch {
                logServiceError(self, appName, 'unknown handler', def.handler);
                continue;
            }

            // Register service
            self.services.set(appName, def);
        }
        catch (err) {
            logServiceError(self, appName, 'load failed', err);
        }
    }
}
