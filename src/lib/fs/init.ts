/**
 * FS Initialization
 *
 * Bootstrap functions for initializing the filesystem during tenant creation.
 * Separate from mount implementations to keep concerns clean.
 */

import type { DatabaseAdapter } from '../database/adapter.js';

/**
 * Initialize filesystem with root user's home directory
 *
 * Creates:
 *   / (root of home mount) - root user's home directory
 *
 * Note: Only user home directories are persisted in the database.
 * The root filesystem (/) uses LocalMount to monkfs/ (read-only).
 * This creates the root entry for /home/root which is mounted at that path.
 *
 * Called during tenant creation, uses raw adapter queries.
 */
export async function initializeFS(
    adapter: DatabaseAdapter,
    rootUserId: string
): Promise<void> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();

    // Create root user's home directory
    // This is the root of the DatabaseMount at /home/root
    // So the path stored is "/" (relative to mount point)
    const id = randomUUID();
    await adapter.query(
        `INSERT INTO fs (id, parent_id, name, path, node_type, mode, owner_id, created_at, updated_at)
         VALUES ($1, NULL, $2, $3, 'directory', $4, $5, $6, $7)`,
        [id, 'root', '/', 0o700, rootUserId, now, now]
    );

    console.info('FS initialized', { directories: 1 });
}
