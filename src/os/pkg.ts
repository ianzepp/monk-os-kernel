/**
 * Package API
 *
 * Provides package management for the OS public API.
 * Handles installation, configuration, and lifecycle of OS packages.
 */

import type { VFS } from '@src/vfs/vfs.js';
import type { PackageOpts, PackageInfo } from './types.js';
import { EEXIST, ENOENT } from '@src/hal/errors.js';

/**
 * Interface for OS methods needed by PackageAPI.
 * Avoids circular dependency with OS class.
 */
export interface PackageAPIHost {
    getVFS(): VFS;
    isBooted(): boolean;
}

/**
 * Internal package record
 */
interface PackageRecord {
    name: string;
    npmName: string;
    version: string;
    mountPoint: string;
    hostPath: string;
    services: string[];
    config: Record<string, unknown>;
    autoStart: boolean;
}

/**
 * Package API for OS
 *
 * Manages installation and lifecycle of OS packages.
 * Packages are npm modules that follow the Monk OS package structure:
 *
 * ```
 * @monk-api/httpd/
 * ├── package.json
 * ├── bin/
 * │   └── httpd.ts
 * ├── etc/
 * │   └── services/
 * │       └── httpd.json
 * └── lib/
 * ```
 *
 * Packages are mounted at `/usr/<name>/` and their services are
 * discovered from `etc/services/*.json`.
 */
export class PackageAPI {
    private host: PackageAPIHost;
    private packages: Map<string, PackageRecord> = new Map();

    // Packages queued before boot (via os.install() chaining)
    private pending: Array<{ npmName: string; opts?: PackageOpts }> = [];

    constructor(host: PackageAPIHost) {
        this.host = host;
    }

    /**
     * Queue a package for installation (pre-boot).
     * Used by OS.install() for chaining before boot.
     *
     * @internal
     */
    queue(npmName: string, opts?: PackageOpts): void {
        this.pending.push({ npmName, opts });
    }

    /**
     * Install all queued packages.
     * Called during boot sequence after VFS is ready.
     *
     * @internal
     */
    async installQueued(): Promise<void> {
        for (const { npmName, opts } of this.pending) {
            await this.install(npmName, opts);
        }

        this.pending = [];
    }

    /**
     * Get all pending packages (for boot sequence).
     *
     * @internal
     */
    getPending(): Array<{ npmName: string; opts?: PackageOpts }> {
        return [...this.pending];
    }

    /**
     * Install a package into the OS.
     *
     * Resolves the npm package path, mounts it into the VFS at `/usr/<name>/`,
     * and discovers any services defined in `etc/services/`.
     *
     * @param npmName - npm package name (e.g., '@monk-api/httpd')
     * @param opts - Installation options
     */
    async install(npmName: string, opts?: PackageOpts): Promise<void> {
        // Resolve the package path
        const hostPath = await this.resolvePackagePath(npmName);

        // Read package.json for metadata
        const pkgJson = await this.readPackageJson(hostPath);
        const name = this.extractName(npmName);
        const version = typeof pkgJson.version === 'string' ? pkgJson.version : '0.0.0';

        // Determine mount point
        const mountPoint = opts?.mountPoint ?? `/usr/${name}`;

        // Check if already installed
        if (this.packages.has(name)) {
            throw new EEXIST(`Package '${name}' is already installed`);
        }

        // Mount the package directory
        const vfs = this.host.getVFS();

        vfs.mountHost(mountPoint, hostPath, { readonly: true });

        // Discover services
        const services = await this.discoverServices(mountPoint);

        // Store package record
        const record: PackageRecord = {
            name,
            npmName,
            version,
            mountPoint,
            hostPath,
            services,
            config: opts?.config ?? {},
            autoStart: opts?.autoStart ?? true,
        };

        this.packages.set(name, record);
    }

    /**
     * Uninstall a package from the OS.
     *
     * Unmounts the package directory and removes it from the registry.
     * Does not stop running services - call service.stop() first.
     *
     * @param name - Package name (e.g., 'httpd')
     */
    async uninstall(name: string): Promise<void> {
        const record = this.packages.get(name);

        if (!record) {
            throw new ENOENT(`Package '${name}' is not installed`);
        }

        // Unmount the package
        const vfs = this.host.getVFS();

        vfs.unmountHost(record.mountPoint);

        // Remove from registry
        this.packages.delete(name);
    }

    /**
     * List all installed packages.
     *
     * @returns Array of package information
     */
    async list(): Promise<PackageInfo[]> {
        return Array.from(this.packages.values()).map(this.toPackageInfo);
    }

    /**
     * Get information about a specific package.
     *
     * @param name - Package name (e.g., 'httpd')
     * @returns Package information, or undefined if not installed
     */
    async get(name: string): Promise<PackageInfo | undefined> {
        const record = this.packages.get(name);

        return record ? this.toPackageInfo(record) : undefined;
    }

    /**
     * Update package configuration.
     *
     * @param name - Package name
     * @param config - New configuration to merge
     */
    async configure(name: string, config: Record<string, unknown>): Promise<void> {
        const record = this.packages.get(name);

        if (!record) {
            throw new ENOENT(`Package '${name}' is not installed`);
        }

        record.config = { ...record.config, ...config };
    }

    /**
     * Get packages that have auto-start enabled.
     *
     * @internal
     */
    getAutoStartPackages(): PackageRecord[] {
        return Array.from(this.packages.values()).filter(p => p.autoStart);
    }

    /**
     * Resolve npm package path to host filesystem path.
     */
    private async resolvePackagePath(npmName: string): Promise<string> {
        try {
            // Use import.meta.resolve to find the package
            // This resolves to the package.json location
            const resolved = import.meta.resolve(`${npmName}/package.json`);

            // Convert file:// URL to path
            const url = new URL(resolved);

            // Return directory (remove /package.json)
            return url.pathname.replace(/\/package\.json$/, '');
        }
        catch {
            throw new ENOENT(
                `Cannot resolve package '${npmName}'. ` +
                    `Ensure it is installed: bun install ${npmName}`,
            );
        }
    }

    /**
     * Read and parse a package's package.json.
     */
    private async readPackageJson(hostPath: string): Promise<Record<string, unknown>> {
        const pkgPath = `${hostPath}/package.json`;

        try {
            const file = Bun.file(pkgPath);
            const text = await file.text();

            return JSON.parse(text);
        }
        catch {
            throw new ENOENT(`Cannot read package.json at ${pkgPath}`);
        }
    }

    /**
     * Extract short package name from npm name.
     * '@monk-api/httpd' -> 'httpd'
     * 'express' -> 'express'
     */
    private extractName(npmName: string): string {
        // Handle scoped packages
        if (npmName.startsWith('@')) {
            const parts = npmName.split('/');

            // Scoped packages always have format @scope/name
            return parts[1] ?? npmName;
        }

        return npmName;
    }

    /**
     * Discover services defined by a package.
     * Scans <mountPoint>/etc/services/*.json
     */
    private async discoverServices(mountPoint: string): Promise<string[]> {
        const services: string[] = [];
        const servicesPath = `${mountPoint}/etc/services`;

        try {
            const vfs = this.host.getVFS();

            // Check if services directory exists
            try {
                await vfs.stat(servicesPath, 'kernel');
            }
            catch {
                // No services directory - that's fine
                return services;
            }

            // List service definitions
            for await (const entry of vfs.readdir(servicesPath, 'kernel')) {
                if (entry.name.endsWith('.json')) {
                    // Service name is filename without .json
                    const serviceName = entry.name.replace(/\.json$/, '');

                    services.push(serviceName);
                }
            }
        }
        catch {
            // Ignore errors - services are optional
        }

        return services;
    }

    /**
     * Convert internal record to public PackageInfo.
     */
    private toPackageInfo(record: PackageRecord): PackageInfo {
        return {
            name: record.name,
            npmName: record.npmName,
            version: record.version,
            mountPoint: record.mountPoint,
            hostPath: record.hostPath,
            services: [...record.services],
            config: { ...record.config },
        };
    }
}
