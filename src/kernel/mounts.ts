/**
 * Mount Configuration
 *
 * Declarative mount definitions for Monk OS.
 * Mounts are defined in /etc/mounts.json and applied at boot.
 */

/**
 * Mount types
 */
import { EINVAL } from '@src/hal/errors.js';

export type MountType = 'memory' | 'host' | 'transpiled-host' | 'storage';

/**
 * Base mount definition
 */
interface BaseMountDef {
    /** VFS path to mount at */
    path: string;

    /** Optional description */
    description?: string;
}

/**
 * Memory mount - ephemeral in-memory filesystem
 */
export interface MemoryMountDef extends BaseMountDef {
    type: 'memory';
    options?: {
        /** Maximum size (e.g., "50MB", "1GB") */
        maxSize?: string;
        /** Make directory world-writable (default: false) */
        worldWritable?: boolean;
    };
}

/**
 * Host mount - pass-through to host filesystem
 */
export interface HostMountDef extends BaseMountDef {
    type: 'host';

    /** Host filesystem path */
    source: string;

    options?: {
        /** Allow writes (default: false) */
        writable?: boolean;
    };
}

/**
 * Transpiled host mount - host filesystem with TypeScript transpilation
 */
export interface TranspiledHostMountDef extends BaseMountDef {
    type: 'transpiled-host';

    /** Host filesystem path */
    source: string;

    options?: {
        /** Import path aliases (e.g., "@monk/process" -> "/lib/process") */
        aliases?: Record<string, string>;

        /** Cache transpiled output (default: true) */
        cache?: boolean;
    };
}

/**
 * Storage mount - backed by HAL storage (SQLite, Postgres, etc.)
 */
export interface StorageMountDef extends BaseMountDef {
    type: 'storage';
    options?: {
        /** Storage backend type */
        backend?: 'memory' | 'sqlite' | 'postgres';
    };
}

/**
 * Union of all mount definitions
 */
export type MountDef =
    | MemoryMountDef
    | HostMountDef
    | TranspiledHostMountDef
    | StorageMountDef;

/**
 * Mounts configuration file structure (/etc/mounts.json)
 */
export interface MountsConfig {
    mounts: MountDef[];
}

/**
 * ACL structure for mount permissions
 */
interface ACL {
    grants: Array<{ to: string; ops: string[] }>;
    deny: string[];
}

/**
 * Dependencies for mount loading
 */
export interface MountLoaderDeps {
    vfs: {
        stat(path: string, caller: string): Promise<unknown>;
        open(path: string, flags: { read: boolean }, caller: string): Promise<{
            read(size: number): Promise<Uint8Array>;
            close(): Promise<void>;
        }>;
        mkdir(path: string, caller: string, opts?: { recursive?: boolean }): Promise<string>;
        mountHost(path: string, source: string, opts?: { readonly?: boolean }): void;
        setAccess(path: string, caller: string, acl: ACL | null): Promise<void>;
    };
    hal: {
        console: {
            error(data: Uint8Array): void;
        };
    };
    loader: {
        setAliases(aliases: Record<string, string>): void;
    };
}

/**
 * Load and apply mounts from /etc/mounts.json
 */
export async function loadMounts(deps: MountLoaderDeps): Promise<void> {
    const { vfs, hal } = deps;
    const mountsPath = '/etc/mounts.json';

    try {
        await vfs.stat(mountsPath, 'kernel');
    } catch {
        // No mounts.json - that's fine, skip
        return;
    }

    try {
        const handle = await vfs.open(mountsPath, { read: true }, 'kernel');
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
        const config = JSON.parse(content) as MountsConfig;

        for (const mount of config.mounts) {
            await applyMount(deps, mount);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        hal.console.error(
            new TextEncoder().encode(`Failed to load mounts: ${msg}\n`)
        );
    }
}

/**
 * Apply a single mount definition.
 */
export async function applyMount(deps: MountLoaderDeps, mount: MountDef): Promise<void> {
    const { vfs, hal, loader } = deps;

    // Ensure mount point exists
    try {
        await vfs.stat(mount.path, 'kernel');
    } catch {
        await vfs.mkdir(mount.path, 'kernel', { recursive: true });
    }

    switch (mount.type) {
        case 'memory':
            // Memory mounts are the default VFS behavior (HAL storage)
            // Set world-writable ACL if requested (e.g., for /tmp)
            if (mount.options?.worldWritable) {
                await vfs.setAccess(mount.path, 'kernel', {
                    grants: [
                        { to: 'kernel', ops: ['*'] },
                        { to: '*', ops: ['read', 'write', 'create', 'delete', 'list', 'stat'] },
                    ],
                    deny: [],
                });
            }
            break;

        case 'host':
            vfs.mountHost(mount.path, mount.source, {
                readonly: !mount.options?.writable,
            });
            break;

        case 'transpiled-host':
            // TODO: Implement TranspiledHostMount
            // For now, mount as regular host mount
            vfs.mountHost(mount.path, mount.source, {
                readonly: true,
            });
            // Store aliases for loader to use
            if (mount.options?.aliases) {
                loader.setAliases(mount.options.aliases);
            }
            break;

        case 'storage':
            // Storage mounts use HAL storage backend
            // This is the default behavior, nothing special needed
            break;

        default:
            hal.console.error(
                new TextEncoder().encode(`Unknown mount type: ${(mount as MountDef).type}\n`)
            );
    }
}

/**
 * Parse a size string like "50MB" or "1GB" to bytes
 */
export function parseSize(size: string): number {
    const match = size.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
    if (!match) {
        throw new EINVAL(`Invalid size format: ${size}`);
    }

    const value = parseFloat(match[1]!);
    const unit = (match[2] ?? 'B').toUpperCase();

    const multipliers: Record<string, number> = {
        'B': 1,
        'KB': 1024,
        'MB': 1024 * 1024,
        'GB': 1024 * 1024 * 1024,
        'TB': 1024 * 1024 * 1024 * 1024,
    };

    const multiplier = multipliers[unit];
    if (multiplier === undefined) {
        throw new EINVAL(`Unknown size unit: ${unit}`);
    }
    return Math.floor(value * multiplier);
}
