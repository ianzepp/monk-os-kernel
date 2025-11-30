import { exec } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { DatabaseConnection } from '@src/lib/database-connection.js';

const execAsync = promisify(exec);

/**
 * InfrastructureService - Manages templates, tenants, sandboxes, and snapshots
 *
 * This service handles all infrastructure database operations for the new four-table model:
 * - templates: Immutable prototypes for cloning
 * - tenants: Production databases
 * - sandboxes: Temporary/experimental databases
 * - snapshots: Point-in-time backups
 */
export class InfrastructureService {
    /**
     * Get main database pool for infrastructure operations
     */
    private static getPool() {
        return DatabaseConnection.getMainPool();
    }

    // ========================================================================
    // TEMPLATES
    // ========================================================================

    /**
     * List all templates
     */
    static async listTemplates(filters?: { is_system?: boolean }) {
        const pool = this.getPool();
        const query = `
            SELECT *
            FROM templates
            ORDER BY is_system DESC, name ASC
        `;

        const result = await pool.query(query);
        return result.rows;
    }

    /**
     * Get template by name
     */
    static async getTemplate(name: string) {
        const pool = this.getPool();
        const result = await pool.query(
            `SELECT * FROM templates WHERE name = $1`,
            [name]
        );

        if (result.rows.length === 0) {
            throw HttpErrors.notFound(`Template '${name}' not found`, 'TEMPLATE_NOT_FOUND');
        }

        return result.rows[0];
    }





    // ========================================================================
    // TENANTS (Internal helpers only - no API routes)
    // ========================================================================

    /**
     * Get tenant by name (internal helper for snapshots)
     * @private
     */
    static async getTenant(name: string) {
        const pool = this.getPool();
        const result = await pool.query(
            `SELECT * FROM tenants WHERE name = $1`,
            [name]
        );

        if (result.rows.length === 0) {
            throw HttpErrors.notFound(`Tenant '${name}' not found`, 'TENANT_NOT_FOUND');
        }

        return result.rows[0];
    }

    // ========================================================================
    // SANDBOXES
    // ========================================================================

    /**
     * List all sandboxes for a tenant
     * Returns all sandboxes owned by the tenant (regardless of creator)
     */
    static async listSandboxes(filters?: { tenant_id?: string; is_active?: boolean }) {
        const pool = this.getPool();
        const conditions: string[] = [];
        const params: any[] = [];

        if (filters?.tenant_id) {
            params.push(filters.tenant_id);
            conditions.push(`parent_tenant_id = $${params.length}`);
        }

        if (filters?.is_active !== undefined) {
            params.push(filters.is_active);
            conditions.push(`is_active = $${params.length}`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await pool.query(
            `SELECT * FROM sandboxes
             ${whereClause}
             ORDER BY created_at DESC`,
            params
        );

        return result.rows;
    }

    /**
     * Get sandbox by name
     */
    static async getSandbox(name: string) {
        const pool = this.getPool();
        const result = await pool.query(
            `SELECT * FROM sandboxes WHERE name = $1`,
            [name]
        );

        if (result.rows.length === 0) {
            throw HttpErrors.notFound(`Sandbox '${name}' not found`, 'SANDBOX_NOT_FOUND');
        }

        return result.rows[0];
    }

    /**
     * Create sandbox from current tenant
     * Sandboxes are tenant-scoped so all admins can manage them
     */
    static async createSandbox(options: {
        tenant_name: string;
        template_name?: string;
        sandbox_name?: string;
        description?: string;
        purpose?: string;
        created_by: string;
        expires_at?: Date;
    }) {
        const pool = this.getPool();

        // Get source tenant (sandbox always belongs to a tenant)
        const tenant = await this.getTenant(options.tenant_name);

        // Determine source database: tenant or template
        let sourceDatabase: string;
        let parentTemplate: string | null = null;

        if (options.template_name) {
            // Clone from template database
            const template = await this.getTemplate(options.template_name);
            sourceDatabase = template.database;
            parentTemplate = options.template_name;
        } else {
            // Clone from current tenant database
            sourceDatabase = tenant.database;
            parentTemplate = null;
        }

        // Sandbox always belongs to the tenant (for team collaboration)
        const parentTenantId = tenant.id;

        // Generate sandbox name if not provided
        const sandboxName = options.sandbox_name || `${options.tenant_name}_sandbox_${Date.now()}`;

        // Generate database name
        const databaseName = `sandbox_${randomBytes(8).toString('hex')}`;

        // Check if name already exists
        const existingCheck = await pool.query(
            'SELECT COUNT(*) FROM sandboxes WHERE name = $1',
            [sandboxName]
        );

        if (existingCheck.rows[0].count > 0) {
            throw HttpErrors.conflict(
                `Sandbox '${sandboxName}' already exists`,
                'SANDBOX_EXISTS'
            );
        }

        // Clone source database
        try {
            await execAsync(`createdb "${databaseName}" -T "${sourceDatabase}"`);
        } catch (error) {
            throw HttpErrors.internal(
                `Failed to clone database: ${error}`,
                'SANDBOX_CLONE_FAILED'
            );
        }

        // Register sandbox (tenant-scoped)
        const result = await pool.query(
            `INSERT INTO sandboxes (name, database, description, purpose, parent_tenant_id, parent_template, created_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
                sandboxName,
                databaseName,
                options.description || null,
                options.purpose || null,
                parentTenantId,
                parentTemplate,
                options.created_by,
                options.expires_at || null,
            ]
        );

        return result.rows[0];
    }

    /**
     * Delete sandbox
     */
    static async deleteSandbox(name: string) {
        const pool = this.getPool();

        // Get sandbox details
        const sandbox = await this.getSandbox(name);

        // Drop the database
        try {
            await execAsync(`dropdb "${sandbox.database}"`);
        } catch (error) {
            throw HttpErrors.internal(
                `Failed to drop sandbox database: ${error}`,
                'SANDBOX_DROP_FAILED'
            );
        }

        // Remove from sandboxes table
        await pool.query('DELETE FROM sandboxes WHERE name = $1', [name]);

        return { success: true, deleted: name };
    }

    /**
     * Extend sandbox expiration
     */
    static async extendSandbox(name: string, expires_at: Date) {
        const pool = this.getPool();

        const result = await pool.query(
            `UPDATE sandboxes
             SET expires_at = $1, last_accessed_at = CURRENT_TIMESTAMP
             WHERE name = $2
             RETURNING *`,
            [expires_at, name]
        );

        if (result.rows.length === 0) {
            throw HttpErrors.notFound(`Sandbox '${name}' not found`, 'SANDBOX_NOT_FOUND');
        }

        return result.rows[0];
    }

    // ========================================================================
    // SNAPSHOTS
    // ========================================================================
    // Note: Snapshots are now stored in tenant databases (not monk database)
    // CRUD operations use Database class and trigger observer pipeline
    // This service provides utility methods for the async observer

    /**
     * Execute pg_dump/restore for snapshot creation
     * Called by async observer after snapshot record created with status='pending'
     */
    static async executePgDump(options: {
        source_database: string;
        target_database: string;
    }): Promise<{ size_bytes: number; record_count: number }> {
        const { source_database, target_database } = options;
        const timestamp = Date.now();
        const dumpFile = `/tmp/snapshot_${timestamp}_${randomBytes(4).toString('hex')}.dump`;

        try {
            // Step 1: pg_dump source database (transaction-safe, doesn't block)
            console.info('Starting pg_dump', { source_database, target_database, dumpFile });

            // Get connection parameters from DATABASE_URL
            const { host, port, user } = DatabaseConnection.getConnectionParams();
            const hostArg = host ? `-h ${host}` : '';
            const portArg = port ? `-p ${port}` : '';
            const userArg = user ? `-U ${user}` : '';

            await execAsync(
                `pg_dump ${hostArg} ${portArg} ${userArg} ` +
                `-d "${source_database}" ` +
                `-Fc ` +  // Custom format (compressed)
                `--no-acl --no-owner ` +  // Skip ownership
                `-f "${dumpFile}"`
            );

            // Step 2: Create empty target database
            console.info('Creating target database', { target_database });
            await execAsync(`createdb ${hostArg} ${portArg} ${userArg} "${target_database}"`);

            // Step 3: Restore dump to target
            console.info('Restoring dump to target', { target_database });
            await execAsync(
                `pg_restore ${hostArg} ${portArg} ${userArg} ` +
                `-d "${target_database}" ` +
                `-j 4 ` +  // 4 parallel jobs
                `"${dumpFile}"`
            );

            // Step 4: Calculate snapshot stats
            const size_bytes = await this.getDatabaseSize(target_database);
            const record_count = await this.countDatabaseRecords(target_database);

            // Step 5: Cleanup dump file
            await execAsync(`rm -f "${dumpFile}"`);

            console.info('Snapshot created successfully', {
                source_database,
                target_database,
                size_bytes,
                record_count
            });

            return { size_bytes, record_count };

        } catch (error) {
            // Cleanup on failure
            await execAsync(`rm -f "${dumpFile}"`).catch(() => {});
            await execAsync(`dropdb --if-exists "${target_database}"`).catch(() => {});

            throw HttpErrors.internal(
                `Failed to create snapshot: ${error}`,
                'SNAPSHOT_CREATION_FAILED'
            );
        }
    }

    /**
     * Delete snapshot database
     * Called when snapshot record is deleted
     */
    static async deleteSnapshotDatabase(database: string) {
        try {
            await execAsync(`dropdb "${database}"`);
            console.info('Snapshot database dropped', { database });
        } catch (error) {
            throw HttpErrors.internal(
                `Failed to drop snapshot database: ${error}`,
                'SNAPSHOT_DROP_FAILED'
            );
        }
    }

    /**
     * Get database size in bytes
     */
    private static async getDatabaseSize(database: string): Promise<number> {
        const pool = this.getPool();
        const result = await pool.query(
            `SELECT pg_database_size($1) as size`,
            [database]
        );
        return parseInt(result.rows[0].size);
    }

    /**
     * Count total records across all user tables
     */
    private static async countDatabaseRecords(database: string): Promise<number> {
        // Connect to target database to count records
        const { Pool } = await import('pg');
        const { host, port, user } = DatabaseConnection.getConnectionParams();
        const tempPool = new Pool({
            host: host || 'localhost',
            port: port ? parseInt(port) : 5432,
            user: user || undefined,
            database: database,
        });

        try {
            const result = await tempPool.query(`
                SELECT SUM(n_live_tup) as count
                FROM pg_stat_user_tables
            `);
            return parseInt(result.rows[0].count || '0');
        } finally {
            await tempPool.end();
        }
    }

    /**
     * Update snapshot metadata in the snapshot's own database
     * After pg_dump, the snapshot DB has stale metadata (status='pending')
     * This updates it to match the source database (status='active')
     */
    static async updateSnapshotMetadata(options: {
        snapshot_id: string;
        database: string;
        status: string;
        size_bytes: number;
        record_count: number;
    }): Promise<void> {
        const { Pool } = await import('pg');
        const { host, port, user } = DatabaseConnection.getConnectionParams();
        const snapshotPool = new Pool({
            host: host || 'localhost',
            port: port ? parseInt(port) : 5432,
            user: user || undefined,
            database: options.database,
        });

        try {
            await snapshotPool.query(
                `UPDATE snapshots
                 SET status = $1, size_bytes = $2, record_count = $3, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $4`,
                [options.status, options.size_bytes, options.record_count, options.snapshot_id]
            );

            console.info('Updated snapshot database metadata', {
                database: options.database,
                snapshot_id: options.snapshot_id,
                status: options.status
            });
        } finally {
            await snapshotPool.end();
        }
    }

    /**
     * Lock snapshot database as read-only
     * Prevents accidental modifications to backup data
     */
    static async lockSnapshotDatabase(database: string): Promise<void> {
        const { Pool } = await import('pg');
        const { host, port, user } = DatabaseConnection.getConnectionParams();

        // Must connect to postgres database to run ALTER DATABASE
        const postgresPool = new Pool({
            host: host || 'localhost',
            port: port ? parseInt(port) : 5432,
            user: user || undefined,
            database: 'postgres',
        });

        try {
            await postgresPool.query(
                `ALTER DATABASE "${database}" SET default_transaction_read_only = on`
            );

            console.info('Locked snapshot database as read-only', { database });
        } catch (error) {
            // Log warning but don't fail - snapshot is still usable
            console.warn('Failed to lock snapshot database', {
                database,
                error: error instanceof Error ? error.message : String(error)
            });
        } finally {
            await postgresPool.end();
        }
    }
}
