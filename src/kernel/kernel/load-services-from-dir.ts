/**
 * Service Loader - Read and parse service definitions from directory
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module loads service definitions (JSON files) from a VFS directory,
 * validates them, and activates them. Each .json file in the directory is
 * parsed as a ServiceDef, validated for handler existence, and activated
 * according to its activation type.
 *
 * Services are deduplicated by name (first loaded wins). This allows packages
 * to override core services by loading earlier in the boot sequence.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Service name is unique (only one service per name)
 *        VIOLATED BY: Not checking self.services.has(name) before loading
 * INV-2: Handler path exists in VFS before activation
 *        VIOLATED BY: Not validating handler path via vfs.stat()
 * INV-3: Service registered before activation
 *        VIOLATED BY: Activating before self.services.set(name, def)
 * INV-4: Load errors don't crash kernel boot (logged and skipped)
 *        VIOLATED BY: Not catching errors per-service
 *
 * CONCURRENCY MODEL
 * =================
 * - Services loaded sequentially from directory (for await loop)
 * - Each service activation may spawn async handlers (fire-and-forget)
 * - VFS operations are async (readdir, open, read, stat)
 * - No parallel loading (services loaded in directory order)
 *
 * NOTE: Bun workers are truly parallel (separate threads), not just async.
 * postMessage crosses thread boundaries. The kernel runs in the main thread
 * while each process runs in its own worker thread.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Service file deleted between readdir and open
 *       MITIGATION: Catch open errors, log and skip (non-fatal)
 * RC-2: Handler file deleted between validation and activation
 *       MITIGATION: Activation will fail when spawning worker (logged by activateService)
 *
 * MEMORY MANAGEMENT
 * =================
 * - Service definitions stored in kernel services Map
 * - File content chunks allocated temporarily, combined, then decoded
 * - No persistent file handles (closed after read)
 *
 * TESTABILITY
 * ===========
 * - VFS can be mocked for testing (inject test service files)
 * - Validation logic testable via invalid service definitions
 * - Error handling testable via missing handlers
 *
 * @module kernel/kernel/load-services-from-dir
 */

import type { Kernel } from '../kernel.js';
import type { ServiceDef } from '../services.js';
import { activateService } from './activate-service.js';
import { logServiceError } from './log-service-error.js';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Load services from a directory.
 *
 * ALGORITHM:
 * 1. Iterate over directory entries
 * 2. For each .json file:
 *    a. Skip if service name already loaded (deduplication)
 *    b. Read file contents via VFS (chunked read)
 *    c. Parse JSON as ServiceDef
 *    d. Validate handler exists via vfs.stat()
 *    e. Register service in kernel table
 *    f. Activate service (spawn handler or start activation loop)
 * 3. Log errors for individual services (don't crash boot)
 *
 * WHY: Services are JSON files for hot-reload and package management
 *      Deduplication allows package overrides (first wins)
 *
 * @param self - Kernel instance
 * @param dir - Directory path containing .json service definitions
 */
export async function loadServicesFromDir(self: Kernel, dir: string): Promise<void> {
    // -------------------------------------------------------------------------
    // Iterate over service files
    // -------------------------------------------------------------------------

    for await (const entry of self.vfs.readdir(dir, 'kernel')) {
        // WHY: Only process .json files (skip other files)
        if (!entry.name.endsWith('.json')) {
            continue;
        }

        const serviceName = entry.name.replace(/\.json$/, '');
        const path = `${dir}/${entry.name}`;

        // -------------------------------------------------------------------------
        // Deduplication (first loaded wins)
        // -------------------------------------------------------------------------

        // WHY: Skip already-loaded services (allows package overrides)
        if (self.services.has(serviceName)) {
            continue;
        }

        try {
            // -------------------------------------------------------------------------
            // Read service definition file
            // -------------------------------------------------------------------------

            // WHY: VFS read is chunked (streaming), must collect all chunks
            const handle = await self.vfs.open(path, { read: true }, 'kernel');
            const chunks: Uint8Array[] = [];

            // Read in 64KB chunks until EOF
            while (true) {
                const chunk = await handle.read(65536);

                if (chunk.length === 0) {
                    break;
                }

                chunks.push(chunk);
            }

            await handle.close();

            // -------------------------------------------------------------------------
            // Combine chunks and parse JSON
            // -------------------------------------------------------------------------

            // WHY: Combine chunks into single buffer for decoding
            const total = chunks.reduce((sum, c) => sum + c.length, 0);
            const combined = new Uint8Array(total);
            let offset = 0;

            for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }

            const content = new TextDecoder().decode(combined);
            const def = JSON.parse(content) as ServiceDef;

            // -------------------------------------------------------------------------
            // Validate handler exists
            // -------------------------------------------------------------------------

            // WHY: Fail early if handler doesn't exist (before activation)
            const handlerPath = def.handler.endsWith('.ts') ? def.handler : def.handler + '.ts';

            try {
                await self.vfs.stat(handlerPath, 'kernel');
            }
            catch {
                logServiceError(self, serviceName, 'unknown handler', def.handler);
                continue;
            }

            // -------------------------------------------------------------------------
            // Register and activate service
            // -------------------------------------------------------------------------

            // WHY: Register before activation (activation may need to lookup service)
            self.services.set(serviceName, def);

            // WHY: Activation spawns handler or starts activation loop
            await activateService(self, serviceName, def);
        }
        catch (err) {
            // -------------------------------------------------------------------------
            // Error handling (per-service, non-fatal)
            // -------------------------------------------------------------------------

            // WHY: Service load errors don't crash boot (log and continue)
            logServiceError(self, serviceName, 'load failed', err);
        }
    }
}
