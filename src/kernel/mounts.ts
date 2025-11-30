/**
 * Mount Configuration
 *
 * Declarative mount definitions for Monk OS.
 * Mounts are defined in /etc/mounts.json and applied at boot.
 */

/**
 * Mount types
 */
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
 * Parse a size string like "50MB" or "1GB" to bytes
 */
export function parseSize(size: string): number {
    const match = size.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
    if (!match) {
        throw new Error(`Invalid size format: ${size}`);
    }

    const value = parseFloat(match[1]);
    const unit = (match[2] || 'B').toUpperCase();

    const multipliers: Record<string, number> = {
        'B': 1,
        'KB': 1024,
        'MB': 1024 * 1024,
        'GB': 1024 * 1024 * 1024,
        'TB': 1024 * 1024 * 1024 * 1024,
    };

    return Math.floor(value * multipliers[unit]);
}
