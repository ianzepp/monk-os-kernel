/**
 * FS Factory
 *
 * Creates filesystem instances with tiered initialization:
 * - Tier 0 (createBaseFS): Static mounts only, no auth required
 * - Tier 1 (applyUserMounts): User-specific mounts requiring auth
 * - Convenience (createFS): Both tiers in one call
 */

import { join } from 'node:path';
import type { System } from '@src/lib/system.js';
import { FS } from './index.js';
import { DatabaseMount } from './mounts/database-mount.js';
import { SystemMount } from './mounts/system-mount.js';
import { DataMount } from './mounts/data-mount.js';
import { DescribeMount } from './mounts/describe-mount.js';
import { FilterMount } from './mounts/filter-mount.js';
import { TrashedMount } from './mounts/trashed-mount.js';
import { ProcMount } from './mounts/proc-mount.js';
import { BinMount } from './mounts/bin-mount.js';
import { LocalMount } from './mounts/local-mount.js';
import { MemoryMountRegistry, UserTmpRegistry } from './mounts/memory-mount.js';

/**
 * Options for applying user mounts
 */
export interface UserMountOptions {
    /** Current session's PID for /proc/self symlink */
    sessionPid?: number | null;
    /** Command names for /bin mount */
    commandNames?: string[];
    /** Username for home directory and /tmp mount */
    username?: string;
}

/** @deprecated Use UserMountOptions instead */
export type CreateFSOptions = UserMountOptions;

// =============================================================================
// TIER 0: Static Bootstrap (no auth required)
// =============================================================================

/**
 * Create a base FS with only static mounts (no auth required)
 *
 * Mounts:
 * - / - Root filesystem from monkfs/ (read-only)
 *
 * This can be created at server start and reused across requests.
 * User-specific mounts are added later via applyUserMounts().
 *
 * @returns FS instance with static mounts only
 */
export function createBaseFS(): FS {
    const fs = new FS();

    // Root filesystem from monkfs/ (read-only)
    if (process.env.PROJECT_ROOT) {
        const monkfsPath = join(process.env.PROJECT_ROOT, 'monkfs');
        fs.mount('/', new LocalMount(monkfsPath, { writable: false }));
    }
    // Note: No fallback for base FS - tests should use createFS() with System

    return fs;
}

// =============================================================================
// TIER 1: User Session (auth required)
// =============================================================================

/**
 * Apply user-specific mounts to an existing FS
 *
 * Adds mounts that require authenticated context:
 * - /tmp - Per-user temporary storage
 * - /api/* - Database-backed API mounts
 * - /proc - Process table
 * - /system - System introspection
 * - /home/{username} - User home directory
 * - /bin - Command binaries
 *
 * @param fs - Base FS instance (from createBaseFS or new FS)
 * @param system - Authenticated system context
 * @param options - User mount options
 */
export function applyUserMounts(fs: FS, system: System, options?: UserMountOptions): void {
    // Temporary storage (per-user when username provided, otherwise per-tenant)
    if (options?.username) {
        fs.mount('/tmp', UserTmpRegistry.get(system.tenant, options.username));
    } else {
        fs.mount('/tmp', MemoryMountRegistry.get(system.tenant));
    }

    // API mounts (require database access)
    fs.mount('/api/data', new DataMount(system));
    fs.mount('/api/describe', new DescribeMount(system));
    fs.mount('/api/find', new FilterMount(system));
    fs.mount('/api/trashed', new TrashedMount(system));

    // Command binaries (read-only)
    if (options?.commandNames?.length) {
        fs.mount('/bin', new BinMount(options.commandNames));
    }

    // Process table (read-only)
    fs.mount('/proc', new ProcMount(system.tenant, options?.sessionPid ?? null));

    // System introspection (read-only)
    fs.mount('/system', new SystemMount(system));

    // User home directory (database-backed, persistent)
    if (options?.username) {
        fs.mount(`/home/${options.username}`, new DatabaseMount(system));
    }
}

// =============================================================================
// CONVENIENCE: Full FS (combines Tier 0 + Tier 1)
// =============================================================================

/**
 * Create a fully configured FS instance with all standard mounts.
 *
 * This is a convenience function that combines createBaseFS() + applyUserMounts().
 * Use this when you need a complete FS in one call.
 *
 * Mounts:
 * - / - Root filesystem from monkfs/ (read-only)
 * - /api/data - CRUD operations on model records
 * - /api/describe - Model schemas
 * - /api/find - Saved queries/filters
 * - /api/trashed - Soft-deleted records
 * - /bin - Built-in commands (read-only)
 * - /proc - Process table (read-only)
 * - /system - System introspection (read-only)
 * - /home/{username} - Persistent storage (database-backed)
 * - /tmp - Temporary storage (per-user, ephemeral)
 *
 * @param system - Authenticated system context
 * @param options - Optional configuration
 * @returns Configured FS instance
 */
export function createFS(system: System, options?: UserMountOptions): FS {
    const fs = new FS(system);

    // Tier 0: Static mounts
    if (process.env.PROJECT_ROOT) {
        const monkfsPath = join(process.env.PROJECT_ROOT, 'monkfs');
        fs.mount('/', new LocalMount(monkfsPath, { writable: false }));
    } else {
        // Fallback for tests or environments without monkfs
        fs.setFallback(MemoryMountRegistry.get(system.tenant));
    }

    // Tier 1: User mounts
    applyUserMounts(fs, system, options);

    return fs;
}
