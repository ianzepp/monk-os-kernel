/**
 * OS Types
 *
 * Shared interfaces for the OS public API.
 */

/**
 * Storage configuration for the OS
 */
export interface StorageConfig {
    type: 'memory' | 'sqlite' | 'postgres';
    url?: string;
    path?: string;
}

/**
 * OS configuration options
 */
export interface OSConfig {
    /**
     * Path aliases for convenient referencing.
     * Maps alias names (e.g., '@app') to OS paths (e.g., '/vol/app').
     */
    aliases?: Record<string, string>;

    /**
     * Storage backend configuration.
     * Defaults to in-memory storage.
     */
    storage?: StorageConfig;

    /**
     * Environment variables available to all processes.
     */
    env?: Record<string, string>;
}

/**
 * Boot options
 */
export interface BootOpts {
    /**
     * Path to init script (inside OS).
     * If provided, spawns this as PID 1.
     */
    main?: string;

    /**
     * Enable kernel debug logging (printk).
     */
    debug?: boolean;
}

/**
 * Mount options for host filesystem mounts
 */
export interface MountOpts {
    /** Mount as read-only */
    readonly?: boolean;
    /** Watch for changes (future: hot reload) */
    watch?: boolean;
}

/**
 * File/directory stat information
 */
export interface Stat {
    /** Entity ID */
    id: string;
    /** Entity type */
    type: 'file' | 'folder' | 'device' | 'link';
    /** Name */
    name: string;
    /** Size in bytes */
    size: number;
    /** Last modified time (ms since epoch) */
    mtime: number;
    /** Created time (ms since epoch) */
    ctime: number;
}
