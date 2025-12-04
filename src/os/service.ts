/**
 * Service API
 *
 * Provides service management for the OS public API.
 * Supports both kernel process services and host services.
 */

import type { VFS } from '@src/vfs/vfs.js';
import type { Kernel } from '@src/kernel/kernel.js';
import type { ServiceDef } from '@src/kernel/services.js';
import type { ServiceInfo, ServiceStatus, HostServiceDef } from './types.js';
import { ENOENT, EEXIST, EINVAL } from '@src/hal/errors.js';

/**
 * Interface for OS methods needed by ServiceAPI.
 */
export interface ServiceAPIHost {
    getKernel(): Kernel;
    getVFS(): VFS;
    resolvePath(path: string): string;
    isBooted(): boolean;
    getEnv(): Record<string, string>;
}

/**
 * Running service record
 */
interface RunningService {
    name: string;
    def: HostServiceDef;
    status: ServiceStatus;
    startedAt: number;
    config: Record<string, unknown>;
    instance?: {
        stop(): void;
        [key: string]: unknown;
    };
    error?: string;
}

/**
 * Service API for OS
 *
 * Provides service registration, lifecycle management, and querying.
 * Supports two service types:
 *
 * 1. **Host services** (`host: true` in definition) - Run directly on Bun
 *    - Handler module exports a `start(config)` function
 *    - Returns an instance with a `stop()` method
 *    - Good for servers that need raw Bun.serve() access
 *
 * 2. **Kernel services** - Run as kernel Worker processes
 *    - Handler is a VFS path to a script
 *    - Uses kernel process model with syscalls
 *    - Good for sandboxed services
 */
export class ServiceAPI {
    private host: ServiceAPIHost;
    private running: Map<string, RunningService> = new Map();

    constructor(host: ServiceAPIHost) {
        this.host = host;
    }

    /**
     * Start a service.
     *
     * @param name - Service name (e.g., 'httpd')
     * @param config - Runtime configuration (merged with defaults)
     *
     * @example
     * ```typescript
     * // Install package first
     * os.install('httpd');
     * await os.boot();
     *
     * // Start with custom config
     * await os.service.start('httpd', { port: 8080, hostname: 'localhost' });
     * ```
     */
    async start(name: string, config: Record<string, unknown> = {}): Promise<void> {
        // Check if already running
        if (this.running.has(name)) {
            throw new EEXIST(`Service '${name}' is already running`);
        }

        // Find service definition
        const def = await this.findServiceDef(name);
        if (!def) {
            throw new ENOENT(`Service '${name}' not found. Is the package installed?`);
        }

        // Merge config with defaults
        const mergedConfig = { ...def.defaults, ...config };

        // Create running record
        const record: RunningService = {
            name,
            def,
            status: 'starting',
            startedAt: Date.now(),
            config: mergedConfig,
        };
        this.running.set(name, record);

        try {
            if (def.host) {
                // Host service - import and call start()
                await this.startHostService(record);
            } else {
                // Kernel service - spawn as process
                await this.startKernelService(record);
            }

            record.status = 'running';
        } catch (err) {
            record.status = 'failed';
            record.error = err instanceof Error ? err.message : String(err);
            throw err;
        }
    }

    /**
     * Stop a running service.
     *
     * @param name - Service name
     */
    async stop(name: string): Promise<void> {
        const record = this.running.get(name);
        if (!record) {
            throw new ENOENT(`Service '${name}' is not running`);
        }

        record.status = 'stopping';

        try {
            if (record.instance?.stop) {
                record.instance.stop();
            }
            // TODO: For kernel services, send SIGTERM to process
        } finally {
            this.running.delete(name);
        }
    }

    /**
     * Restart a service.
     */
    async restart(name: string): Promise<void> {
        const record = this.running.get(name);
        if (!record) {
            throw new ENOENT(`Service '${name}' is not running`);
        }

        const config = record.config;
        await this.stop(name);
        await this.start(name, config);
    }

    /**
     * Get information about a specific service.
     */
    async get(name: string): Promise<ServiceInfo | undefined> {
        const record = this.running.get(name);
        if (!record) {
            return undefined;
        }

        return this.toServiceInfo(record);
    }

    /**
     * List all running services.
     */
    async list(): Promise<ServiceInfo[]> {
        return Array.from(this.running.values()).map((r) => this.toServiceInfo(r));
    }

    /**
     * Register a service without starting it.
     * (For kernel services with activation triggers)
     */
    async register(_config: ServiceDef): Promise<void> {
        // TODO: Implement for kernel services with socket activation
        throw new EINVAL('os.service.register() not yet implemented');
    }

    /**
     * Unregister a service.
     */
    async unregister(name: string): Promise<void> {
        if (this.running.has(name)) {
            await this.stop(name);
        }
        // TODO: Remove from kernel service registry
    }

    /**
     * Find service definition by name.
     * Searches installed packages for matching service.
     */
    private async findServiceDef(name: string): Promise<HostServiceDef | null> {
        const vfs = this.host.getVFS();

        // Look in /usr/*/etc/services/<name>.json
        try {
            // First, try the package with the same name
            const directPath = `/usr/${name}/etc/services/${name}.json`;
            try {
                const content = await this.readVfsFile(vfs, directPath);
                return JSON.parse(content) as HostServiceDef;
            } catch {
                // Not found at direct path, continue searching
            }

            // Search all packages under /usr/
            for await (const entry of vfs.readdir('/usr', 'kernel')) {
                if (entry.type !== 'folder') continue;

                const servicePath = `/usr/${entry.name}/etc/services/${name}.json`;
                try {
                    const content = await this.readVfsFile(vfs, servicePath);
                    return JSON.parse(content) as HostServiceDef;
                } catch {
                    // Not in this package
                }
            }
        } catch {
            // /usr doesn't exist or not readable
        }

        return null;
    }

    /**
     * Read a file from VFS as string.
     */
    private async readVfsFile(vfs: VFS, path: string): Promise<string> {
        const handle = await vfs.open(path, { read: true }, 'kernel');
        try {
            // Read entire file content
            const content = await handle.read();
            return new TextDecoder().decode(content);
        } finally {
            await handle.close();
        }
    }

    /**
     * Start a host service (runs directly on Bun).
     */
    private async startHostService(record: RunningService): Promise<void> {
        const vfs = this.host.getVFS();

        // Resolve handler path to host filesystem path
        const handlerPath = record.def.handler;

        // Get the host path from VFS mount
        const hostPath = vfs.resolveToHostPath(handlerPath);
        if (!hostPath) {
            throw new ENOENT(`Cannot resolve handler path: ${handlerPath}`);
        }

        // Dynamically import the module
        const module = await import(hostPath);

        if (typeof module.start !== 'function') {
            throw new EINVAL(`Service handler must export a start() function: ${handlerPath}`);
        }

        // Pass OS env and fs API to the service
        const configWithEnv = {
            ...record.config,
            env: this.host.getEnv(),
            vfs: this.host.getVFS(),
        };

        // Call start with config (including OS env and VFS access)
        record.instance = module.start(configWithEnv);
    }

    /**
     * Start a kernel service (runs as Worker process).
     */
    private async startKernelService(_record: RunningService): Promise<void> {
        // TODO: Implement kernel process spawning
        throw new EINVAL('Kernel services not yet implemented. Use host: true in service definition.');
    }

    /**
     * Convert running record to ServiceInfo.
     */
    private toServiceInfo(record: RunningService): ServiceInfo {
        return {
            name: record.name,
            handler: record.def.handler,
            status: record.status,
            activationType: record.def.activate.type,
            startedAt: record.startedAt,
            config: record.config,
            error: record.error,
        };
    }
}
