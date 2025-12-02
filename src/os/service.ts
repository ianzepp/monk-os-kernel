/**
 * Service API
 *
 * Provides service management for the OS public API.
 */

import type { Kernel } from '@src/kernel/kernel.js';
import type { ServiceDef } from '@src/kernel/services.js';
import type { ServiceInfo } from './types.js';

/**
 * Interface for OS methods needed by ServiceAPI.
 * Avoids circular dependency with OS class.
 */
export interface ServiceAPIHost {
    getKernel(): Kernel;
    resolvePath(path: string): string;
}

/**
 * Service API for OS
 *
 * Provides service registration, lifecycle management, and querying.
 */
export class ServiceAPI {
    // Host reference for when methods are implemented
    // @ts-expect-error Unused until implementation
    private host: ServiceAPIHost;

    constructor(host: ServiceAPIHost) {
        this.host = host;
    }

    /**
     * Start a service.
     *
     * Can be called with either a service definition or a path to a service
     * config file in /etc/services/.
     *
     * @param config - Service definition or path to service config
     *
     * @example
     * ```typescript
     * // Start with inline definition
     * await os.service.start({
     *   handler: '@app/server.ts',
     *   activate: { type: 'tcp:listen', port: 8080 },
     * });
     *
     * // Start from config file
     * await os.service.start('/etc/services/api.json');
     * ```
     */
    async start(_config: string | ServiceDef): Promise<void> {
        // TODO: Implement service start
        // - If string, load service def from path
        // - Resolve handler path through aliases
        // - Register with kernel
        // - Start based on activation type

        throw new Error('os.service.start() not implemented');
    }

    /**
     * Stop a running service.
     *
     * @param name - Service name (usually derived from handler path)
     *
     * @example
     * ```typescript
     * await os.service.stop('server');
     * ```
     */
    async stop(_name: string): Promise<void> {
        // TODO: Implement service stop
        // - Find service by name
        // - Send shutdown signal
        // - Wait for graceful stop or force kill

        throw new Error('os.service.stop() not implemented');
    }

    /**
     * Restart a service.
     *
     * Stops the service if running, then starts it again.
     *
     * @param name - Service name
     *
     * @example
     * ```typescript
     * await os.service.restart('server');
     * ```
     */
    async restart(_name: string): Promise<void> {
        // TODO: Implement service restart
        // - Stop if running
        // - Start again

        throw new Error('os.service.restart() not implemented');
    }

    /**
     * Get information about a specific service.
     *
     * @param name - Service name
     * @returns Service information or undefined if not found
     *
     * @example
     * ```typescript
     * const info = await os.service.get('server');
     * if (info?.status === 'running') {
     *   console.log(`Server running on PID ${info.pid}`);
     * }
     * ```
     */
    async get(_name: string): Promise<ServiceInfo | undefined> {
        // TODO: Implement service get
        // - Look up service by name
        // - Return status information

        throw new Error('os.service.get() not implemented');
    }

    /**
     * List all registered services.
     *
     * @returns Array of service information
     *
     * @example
     * ```typescript
     * const services = await os.service.list();
     * for (const svc of services) {
     *   console.log(`${svc.name}: ${svc.status}`);
     * }
     * ```
     */
    async list(): Promise<ServiceInfo[]> {
        // TODO: Implement service list
        // - Get all registered services from kernel
        // - Return status information for each

        throw new Error('os.service.list() not implemented');
    }

    /**
     * Register a service without starting it.
     *
     * The service will be started based on its activation type
     * (e.g., on boot, on first connection, etc.).
     *
     * @param config - Service definition
     *
     * @example
     * ```typescript
     * // Register for socket activation
     * await os.service.register({
     *   handler: '@app/api.ts',
     *   activate: { type: 'tcp:listen', port: 3000 },
     * });
     * // Service starts when first connection arrives on port 3000
     * ```
     */
    async register(_config: ServiceDef): Promise<void> {
        // TODO: Implement service register
        // - Resolve handler path
        // - Store service definition
        // - Set up activation trigger (but don't start yet)

        throw new Error('os.service.register() not implemented');
    }

    /**
     * Unregister a service.
     *
     * Stops the service if running and removes its registration.
     *
     * @param name - Service name
     */
    async unregister(_name: string): Promise<void> {
        // TODO: Implement service unregister
        // - Stop if running
        // - Remove from registry

        throw new Error('os.service.unregister() not implemented');
    }
}
