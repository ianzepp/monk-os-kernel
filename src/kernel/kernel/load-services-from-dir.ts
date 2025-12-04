/**
 * Load services from a directory.
 *
 * @module kernel/kernel/load-services-from-dir
 */

import type { Kernel } from '../kernel.js';
import type { ServiceDef } from '../services.js';
import { activateService } from './activate-service.js';
import { logServiceError } from './log-service-error.js';

/**
 * Load services from a directory.
 *
 * @param self - Kernel instance
 * @param dir - Directory path
 */
export async function loadServicesFromDir(self: Kernel, dir: string): Promise<void> {
    for await (const entry of self.vfs.readdir(dir, 'kernel')) {
        if (!entry.name.endsWith('.json')) continue;

        const serviceName = entry.name.replace(/\.json$/, '');
        const path = `${dir}/${entry.name}`;

        // Skip if already loaded
        if (self.services.has(serviceName)) {
            continue;
        }

        try {
            // Read service definition
            const handle = await self.vfs.open(path, { read: true }, 'kernel');
            const chunks: Uint8Array[] = [];
            while (true) {
                const chunk = await handle.read(65536);
                if (chunk.length === 0) break;
                chunks.push(chunk);
            }
            await handle.close();

            const total = chunks.reduce((sum, c) => sum + c.length, 0);
            const combined = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }

            const content = new TextDecoder().decode(combined);
            const def = JSON.parse(content) as ServiceDef;

            // Validate handler exists
            const handlerPath = def.handler.endsWith('.ts') ? def.handler : def.handler + '.ts';
            try {
                await self.vfs.stat(handlerPath, 'kernel');
            } catch {
                logServiceError(self, serviceName, 'unknown handler', def.handler);
                continue;
            }

            self.services.set(serviceName, def);
            await activateService(self, serviceName, def);
        } catch (err) {
            logServiceError(self, serviceName, 'load failed', err);
        }
    }
}
