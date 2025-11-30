/**
 * Infrastructure Database Management
 *
 * Manages the core infrastructure (tenants registry) and tenant provisioning.
 * Supports both PostgreSQL and SQLite backends.
 *
 * Architecture:
 *   PostgreSQL: monk database, public schema (infra), ns_tenant_* schemas (tenants)
 *   SQLite: .data/monk/public.db (infra), .data/monk/ns_tenant_*.db (tenants)
 *
 * Usage:
 *   await Infrastructure.initialize();  // At startup
 *   const tenant = await Infrastructure.getTenant('acme');
 *   const result = await Infrastructure.createTenant({ name: 'newco' });
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { DatabaseAdapter, DatabaseType } from './database/adapter.js';

// SQL schemas embedded at build time
import INFRA_SCHEMA_POSTGRESQL from './sql/monk.pg.sql' with { type: 'text' };
import INFRA_SCHEMA_SQLITE from './sql/monk.sqlite.sql' with { type: 'text' };
import TENANT_SCHEMA_POSTGRESQL from './sql/tenant.pg.sql' with { type: 'text' };
import TENANT_SCHEMA_SQLITE from './sql/tenant.sqlite.sql' with { type: 'text' };

/**
 * Well-known UUID for root user in every tenant.
 * Using zero UUID is safe because each tenant has isolated database/schema.
 * Exported for use in tests and other modules that need to reference root user.
 */
export const ROOT_USER_ID = '00000000-0000-0000-0000-000000000000';

// SQLite seed with static values only - no user input interpolation
// Root user customization happens via parameterized UPDATE after seed
const TENANT_SEED_SQLITE = `
-- Register core models
INSERT OR IGNORE INTO "models" (id, model_name, status, sudo, description) VALUES
    ('${randomUUID()}', 'models', 'system', 1, NULL),
    ('${randomUUID()}', 'fields', 'system', 1, NULL),
    ('${randomUUID()}', 'users', 'system', 1, NULL),
    ('${randomUUID()}', 'filters', 'system', 0, NULL),
    ('${randomUUID()}', 'credentials', 'system', 1, 'User authentication credentials'),
    ('${randomUUID()}', 'tracked', 'system', 1, 'Change tracking and audit trail'),
    ('${randomUUID()}', 'fs', 'system', 1, 'Filesystem nodes'),
    ('${randomUUID()}', 'memories', 'system', 0, 'Long-term memory storage for AI agents');

-- Fields for models
INSERT OR IGNORE INTO "fields" (id, model_name, field_name, type, required, default_value, description) VALUES
    ('${randomUUID()}', 'models', 'model_name', 'text', 1, NULL, 'Unique name for the model'),
    ('${randomUUID()}', 'models', 'status', 'text', 0, 'active', 'Model status'),
    ('${randomUUID()}', 'models', 'description', 'text', 0, NULL, 'Human-readable description'),
    ('${randomUUID()}', 'models', 'sudo', 'boolean', 0, NULL, 'Whether model modifications require sudo'),
    ('${randomUUID()}', 'models', 'frozen', 'boolean', 0, NULL, 'Whether data changes are prevented'),
    ('${randomUUID()}', 'models', 'immutable', 'boolean', 0, NULL, 'Whether records are write-once'),
    ('${randomUUID()}', 'models', 'external', 'boolean', 0, NULL, 'Whether model is managed externally');

-- Fields for fields
INSERT OR IGNORE INTO "fields" (id, model_name, field_name, type, required, description) VALUES
    ('${randomUUID()}', 'fields', 'model_name', 'text', 1, 'Name of the model'),
    ('${randomUUID()}', 'fields', 'field_name', 'text', 1, 'Name of the field'),
    ('${randomUUID()}', 'fields', 'type', 'text', 1, 'Data type'),
    ('${randomUUID()}', 'fields', 'required', 'boolean', 0, 'Whether required'),
    ('${randomUUID()}', 'fields', 'default_value', 'text', 0, 'Default value'),
    ('${randomUUID()}', 'fields', 'description', 'text', 0, 'Description'),
    ('${randomUUID()}', 'fields', 'relationship_type', 'text', 0, 'Relationship type'),
    ('${randomUUID()}', 'fields', 'related_model', 'text', 0, 'Related model'),
    ('${randomUUID()}', 'fields', 'related_field', 'text', 0, 'Related field'),
    ('${randomUUID()}', 'fields', 'relationship_name', 'text', 0, 'Relationship name'),
    ('${randomUUID()}', 'fields', 'cascade_delete', 'boolean', 0, 'Cascade delete'),
    ('${randomUUID()}', 'fields', 'required_relationship', 'boolean', 0, 'Required relationship'),
    ('${randomUUID()}', 'fields', 'minimum', 'numeric', 0, 'Minimum value'),
    ('${randomUUID()}', 'fields', 'maximum', 'numeric', 0, 'Maximum value'),
    ('${randomUUID()}', 'fields', 'pattern', 'text', 0, 'Regex pattern'),
    ('${randomUUID()}', 'fields', 'enum_values', 'text[]', 0, 'Enum values'),
    ('${randomUUID()}', 'fields', 'is_array', 'boolean', 0, 'Is array'),
    ('${randomUUID()}', 'fields', 'immutable', 'boolean', 0, 'Immutable'),
    ('${randomUUID()}', 'fields', 'sudo', 'boolean', 0, 'Requires sudo'),
    ('${randomUUID()}', 'fields', 'unique', 'boolean', 0, 'Must be unique'),
    ('${randomUUID()}', 'fields', 'index', 'boolean', 0, 'Create index'),
    ('${randomUUID()}', 'fields', 'tracked', 'boolean', 0, 'Track changes'),
    ('${randomUUID()}', 'fields', 'searchable', 'boolean', 0, 'Full-text search'),
    ('${randomUUID()}', 'fields', 'transform', 'text', 0, 'Auto-transform');

-- Fields for users
INSERT OR IGNORE INTO "fields" (id, model_name, field_name, type, required, description) VALUES
    ('${randomUUID()}', 'users', 'name', 'text', 1, 'User display name'),
    ('${randomUUID()}', 'users', 'auth', 'text', 1, 'Authentication identifier'),
    ('${randomUUID()}', 'users', 'access', 'text', 1, 'User access level');

-- Fields for filters
INSERT OR IGNORE INTO "fields" (id, model_name, field_name, type, required, description) VALUES
    ('${randomUUID()}', 'filters', 'name', 'text', 1, 'Filter name'),
    ('${randomUUID()}', 'filters', 'model_name', 'text', 1, 'Target model'),
    ('${randomUUID()}', 'filters', 'description', 'text', 0, 'Description'),
    ('${randomUUID()}', 'filters', 'select', 'jsonb', 0, 'Fields to return'),
    ('${randomUUID()}', 'filters', 'where', 'jsonb', 0, 'Filter conditions'),
    ('${randomUUID()}', 'filters', 'order', 'jsonb', 0, 'Sort order'),
    ('${randomUUID()}', 'filters', 'limit', 'integer', 0, 'Max records'),
    ('${randomUUID()}', 'filters', 'offset', 'integer', 0, 'Records to skip');

-- Fields for credentials
INSERT OR IGNORE INTO "fields" (id, model_name, field_name, type, required, description) VALUES
    ('${randomUUID()}', 'credentials', 'user_id', 'uuid', 1, 'Reference to the user'),
    ('${randomUUID()}', 'credentials', 'type', 'text', 1, 'Credential type: password, api_key'),
    ('${randomUUID()}', 'credentials', 'identifier', 'text', 0, 'Public identifier (API key prefix)'),
    ('${randomUUID()}', 'credentials', 'secret', 'text', 1, 'Hashed secret value'),
    ('${randomUUID()}', 'credentials', 'algorithm', 'text', 0, 'Hashing algorithm used'),
    ('${randomUUID()}', 'credentials', 'permissions', 'text', 0, 'JSON permissions for API keys'),
    ('${randomUUID()}', 'credentials', 'name', 'text', 0, 'Friendly name for the credential'),
    ('${randomUUID()}', 'credentials', 'expires_at', 'timestamp', 0, 'Expiration timestamp'),
    ('${randomUUID()}', 'credentials', 'last_used_at', 'timestamp', 0, 'Last usage timestamp');

-- Fields for tracked
INSERT OR IGNORE INTO "fields" (id, model_name, field_name, type, required, description) VALUES
    ('${randomUUID()}', 'tracked', 'change_id', 'bigserial', 1, 'Auto-incrementing change identifier'),
    ('${randomUUID()}', 'tracked', 'model_name', 'text', 1, 'Model where the change occurred'),
    ('${randomUUID()}', 'tracked', 'record_id', 'uuid', 1, 'ID of the changed record'),
    ('${randomUUID()}', 'tracked', 'operation', 'text', 1, 'Operation type: create, update, delete'),
    ('${randomUUID()}', 'tracked', 'changes', 'jsonb', 1, 'Field-level changes with old/new values'),
    ('${randomUUID()}', 'tracked', 'created_by', 'uuid', 0, 'ID of the user who made the change'),
    ('${randomUUID()}', 'tracked', 'request_id', 'text', 0, 'Request correlation ID'),
    ('${randomUUID()}', 'tracked', 'metadata', 'jsonb', 0, 'Additional context');

-- Fields for fs
INSERT OR IGNORE INTO "fields" (id, model_name, field_name, type, required, description) VALUES
    ('${randomUUID()}', 'fs', 'parent_id', 'uuid', 0, 'Parent directory'),
    ('${randomUUID()}', 'fs', 'name', 'text', 1, 'File or directory name'),
    ('${randomUUID()}', 'fs', 'path', 'text', 1, 'Full absolute path'),
    ('${randomUUID()}', 'fs', 'node_type', 'text', 1, 'Node type: file, directory, symlink'),
    ('${randomUUID()}', 'fs', 'content', 'binary', 0, 'File content'),
    ('${randomUUID()}', 'fs', 'target', 'text', 0, 'Symlink target path'),
    ('${randomUUID()}', 'fs', 'mode', 'integer', 0, 'Unix permission bits'),
    ('${randomUUID()}', 'fs', 'size', 'integer', 0, 'Content size in bytes'),
    ('${randomUUID()}', 'fs', 'owner_id', 'uuid', 0, 'Owner user ID');

-- Fields for memories (long-term memory)
INSERT OR IGNORE INTO "fields" (id, model_name, field_name, type, required, searchable, description) VALUES
    ('${randomUUID()}', 'memories', 'owner', 'text', 1, 0, 'Username who owns this memory'),
    ('${randomUUID()}', 'memories', 'content', 'text', 1, 1, 'Memory content (full-text searchable)');

-- Root user with well-known ID (customized via parameterized UPDATE if needed)
INSERT OR IGNORE INTO "users" (id, name, auth, access) VALUES
    ('${ROOT_USER_ID}', 'Root User', 'root', 'root');
`;

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface InfraConfig {
    dbType: DatabaseType;
    database: string;  // 'monk' for both PG and SQLite
    schema: string;    // 'public' for infra
}

let cachedConfig: InfraConfig | null = null;

/**
 * Parse DATABASE_URL and determine infrastructure configuration
 *
 * DATABASE_URL formats:
 *   postgresql://user:pass@host:port/dbname  → PostgreSQL mode
 *   sqlite:monk                               → SQLite mode
 *   (absent)                                  → SQLite mode (default)
 */
export function parseInfraConfig(): InfraConfig {
    if (cachedConfig) {
        return cachedConfig;
    }

    const databaseUrl = process.env.DATABASE_URL || '';

    if (databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')) {
        // PostgreSQL mode - extract database name from URL
        const url = new URL(databaseUrl);
        const database = url.pathname.slice(1) || 'monk';

        cachedConfig = {
            dbType: 'postgresql',
            database,
            schema: 'public',
        };
    } else {
        // SQLite mode (default)
        // DATABASE_URL=sqlite:monk or absent → database='monk'
        const database = databaseUrl.startsWith('sqlite:')
            ? databaseUrl.slice(7) || 'monk'
            : 'monk';

        cachedConfig = {
            dbType: 'sqlite',
            database,
            schema: 'public',
        };
    }

    return cachedConfig;
}

// =============================================================================
// TENANT RECORD TYPE
// =============================================================================

export interface TenantRecord {
    id: string;
    name: string;
    db_type: DatabaseType;
    database: string;
    schema: string;
    owner_id: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
}

export interface UserRecord {
    id: string;
    name: string;
    auth: string;
    access: string;
}

export interface CreateTenantResult {
    tenant: TenantRecord;
    user: UserRecord;
}

// =============================================================================
// INFRASTRUCTURE CLASS
// =============================================================================

export class Infrastructure {
    private static infraAdapter: DatabaseAdapter | null = null;

    /**
     * Get or create the infrastructure database adapter
     *
     * This is a singleton that connects to the infrastructure database
     * (tenants registry). For SQLite, this is .data/monk/public.db.
     * For PostgreSQL, this is the public schema in the monk database.
     */
    static async getAdapter(): Promise<DatabaseAdapter> {
        if (this.infraAdapter) {
            return this.infraAdapter;
        }

        const config = parseInfraConfig();
        const { createAdapterFrom } = await import('./database/index.js');

        // Ensure data directory exists for SQLite
        if (config.dbType === 'sqlite') {
            const dataDir = process.env.SQLITE_DATA_DIR || '.data';
            const dbDir = join(dataDir, config.database);
            if (!existsSync(dbDir)) {
                mkdirSync(dbDir, { recursive: true });
            }
        }

        this.infraAdapter = createAdapterFrom(config.dbType, config.database, config.schema);
        return this.infraAdapter;
    }

    /**
     * Initialize infrastructure tables
     *
     * Idempotent - safe to call multiple times.
     * Creates tenants and tenant_fixtures tables if they don't exist.
     */
    static async initialize(): Promise<void> {
        const config = parseInfraConfig();
        const adapter = await this.getAdapter();

        console.info('Initializing infrastructure', { dbType: config.dbType, database: config.database });

        await adapter.connect();

        try {
            const schema = config.dbType === 'sqlite' ? INFRA_SCHEMA_SQLITE : INFRA_SCHEMA_POSTGRESQL;

            if (config.dbType === 'sqlite') {
                // SQLite: execute via raw connection (handles multiple statements)
                const db = adapter.getRawConnection() as { exec: (sql: string) => void };
                db.exec(schema);
            } else {
                // PostgreSQL: execute as single query
                await adapter.query(schema);
            }

            console.info('Infrastructure ready');
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Check if infrastructure is initialized
     */
    static async isInitialized(): Promise<boolean> {
        const adapter = await this.getAdapter();
        await adapter.connect();

        try {
            const config = parseInfraConfig();
            const sql = config.dbType === 'sqlite'
                ? `SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'`
                : `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='tenants'`;

            const result = await adapter.query<{ name?: string; table_name?: string }>(sql);
            return result.rows.length > 0;
        } catch {
            return false;
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Get tenant by name
     */
    static async getTenant(tenantName: string): Promise<TenantRecord | null> {
        const adapter = await this.getAdapter();
        await adapter.connect();

        try {
            const result = await adapter.query<TenantRecord>(
                `SELECT id, name, db_type, database, schema, owner_id, is_active, created_at, updated_at
                 FROM tenants
                 WHERE name = $1 AND is_active = true AND trashed_at IS NULL AND deleted_at IS NULL`,
                [tenantName]
            );

            if (result.rows.length === 0) {
                return null;
            }

            const row = result.rows[0];
            return {
                ...row,
                is_active: Boolean(row.is_active),
            };
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Create a new tenant with full provisioning
     *
     * This method:
     * 1. Creates the tenant database/schema
     * 2. Deploys core tables (models, fields, users, filters)
     * 3. Seeds model/field metadata
     * 4. Creates root user
     * 5. Registers tenant in infrastructure database
     */
    static async createTenant(options: {
        name: string;
        db_type?: DatabaseType;
        owner_username?: string;
        description?: string;
    }): Promise<CreateTenantResult> {
        const config = parseInfraConfig();
        const dbType = options.db_type || config.dbType;
        const ownerUsername = options.owner_username || 'root';

        // Validate tenant name
        const tenantName = options.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (!tenantName || tenantName.length < 2) {
            throw new Error('Tenant name must be at least 2 characters');
        }

        // Generate tenant ID (root user uses well-known ROOT_USER_ID)
        const tenantId = randomUUID();
        const schemaName = `ns_tenant_${tenantName}`;
        const database = config.database;  // Always 'monk'

        console.info('Creating tenant', { name: tenantName, dbType, schema: schemaName });

        // Check if tenant already exists
        const existing = await this.getTenant(tenantName);
        if (existing) {
            throw new Error(`Tenant '${tenantName}' already exists`);
        }

        // Step 1: Create tenant database/schema
        await this.provisionTenantDatabase(dbType, database, schemaName);

        // Step 2: Deploy tenant schema and seed data (returns owner user ID)
        const ownerUserId = await this.deployTenantSchema(dbType, database, schemaName, ownerUsername);

        // Step 3: Register tenant in infrastructure
        const infraAdapter = await this.getAdapter();
        await infraAdapter.connect();

        try {
            const timestamp = new Date().toISOString();

            await infraAdapter.query(
                `INSERT INTO tenants (id, name, db_type, database, schema, owner_id, description, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    tenantId,
                    tenantName,
                    dbType,
                    database,
                    schemaName,
                    ownerUserId,
                    options.description || null,
                    timestamp,
                    timestamp,
                ]
            );
        } finally {
            await infraAdapter.disconnect();
        }

        console.info('Tenant created', { name: tenantName, id: tenantId });

        // Return owner user info (root user if ownerUsername='root', separate user otherwise)
        const ownerDisplayName = ownerUsername === 'root' ? 'Root User' : ownerUsername;

        return {
            tenant: {
                id: tenantId,
                name: tenantName,
                db_type: dbType,
                database,
                schema: schemaName,
                owner_id: ownerUserId,
                is_active: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            },
            user: {
                id: ownerUserId,
                name: ownerDisplayName,
                auth: ownerUsername,
                access: 'root',
            },
        };
    }

    /**
     * Soft delete a tenant
     *
     * Sets deleted_at and is_active=false. Tenant cannot log in after this.
     * Database/schema files remain for recovery.
     */
    static async deleteTenant(tenantName: string): Promise<boolean> {
        const adapter = await this.getAdapter();
        await adapter.connect();

        try {
            const timestamp = new Date().toISOString();

            const result = await adapter.query(
                `UPDATE tenants
                 SET deleted_at = $1, is_active = false, updated_at = $1
                 WHERE name = $2 AND deleted_at IS NULL`,
                [timestamp, tenantName]
            );

            return result.rowCount > 0;
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * List all active tenants
     */
    static async listTenants(): Promise<TenantRecord[]> {
        const adapter = await this.getAdapter();
        await adapter.connect();

        try {
            const result = await adapter.query<TenantRecord>(
                `SELECT id, name, db_type, database, schema, owner_id, is_active, created_at, updated_at
                 FROM tenants
                 WHERE is_active = true AND trashed_at IS NULL AND deleted_at IS NULL
                 ORDER BY created_at DESC`
            );

            return result.rows.map(row => ({
                ...row,
                is_active: Boolean(row.is_active),
            }));
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Record fixture deployment for a tenant
     */
    static async recordFixtureDeployment(tenantId: string, fixtureName: string): Promise<void> {
        const adapter = await this.getAdapter();
        await adapter.connect();

        try {
            await adapter.query(
                `INSERT INTO tenant_fixtures (tenant_id, fixture_name, deployed_at)
                 VALUES ($1, $2, CURRENT_TIMESTAMP)
                 ON CONFLICT (tenant_id, fixture_name) DO NOTHING`,
                [tenantId, fixtureName]
            );
        } finally {
            await adapter.disconnect();
        }
    }

    // =========================================================================
    // PRIVATE METHODS
    // =========================================================================

    /**
     * Create the tenant database/schema
     */
    private static async provisionTenantDatabase(
        dbType: DatabaseType,
        database: string,
        schemaName: string
    ): Promise<void> {
        const { createAdapterFrom } = await import('./database/index.js');

        if (dbType === 'sqlite') {
            // SQLite: Ensure directory exists, file created on connect
            const dataDir = process.env.SQLITE_DATA_DIR || '.data';
            const dbPath = join(dataDir, database, `${schemaName}.db`);
            const dirPath = dirname(dbPath);

            if (!existsSync(dirPath)) {
                mkdirSync(dirPath, { recursive: true });
            }

            // Touch file by connecting (adapter creates file)
            const adapter = createAdapterFrom('sqlite', database, schemaName);
            await adapter.connect();
            await adapter.disconnect();
        } else {
            // PostgreSQL: Create schema
            const adapter = createAdapterFrom('postgresql', database, 'public');
            await adapter.connect();

            try {
                await adapter.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
            } finally {
                await adapter.disconnect();
            }
        }
    }

    /**
     * Deploy tenant schema (tables) and seed data
     *
     * Creates models, fields, users, filters tables and seeds with root user.
     * If ownerUsername differs from 'root', creates an additional owner user.
     * Used internally by createTenant() and by apps/loader for app namespaces.
     *
     * Unix model: root always exists (auth='root', id=ROOT_USER_ID).
     * Owner user is separate if username != 'root'.
     *
     * @returns Owner user ID (ROOT_USER_ID if owner is root, random UUID otherwise)
     */
    static async deployTenantSchema(
        dbType: DatabaseType,
        database: string,
        schemaName: string,
        ownerUsername: string
    ): Promise<string> {
        const { createAdapterFrom } = await import('./database/index.js');
        const adapter = createAdapterFrom(dbType, database, schemaName);

        // Determine owner user ID - root uses well-known ID, others get random UUID
        const ownerUserId = ownerUsername === 'root' ? ROOT_USER_ID : randomUUID();

        await adapter.connect();

        try {
            if (dbType === 'sqlite') {
                // SQLite: Execute schema + seed via raw connection
                const db = adapter.getRawConnection() as { exec: (sql: string) => void };

                db.exec('BEGIN');
                try {
                    db.exec(TENANT_SCHEMA_SQLITE);
                    db.exec(TENANT_SEED_SQLITE);

                    // If owner is not root, create separate owner user
                    if (ownerUsername !== 'root') {
                        await adapter.query(
                            `INSERT INTO users (id, name, auth, access) VALUES ($1, $2, $3, 'root')`,
                            [ownerUserId, ownerUsername, ownerUsername]
                        );
                    }

                    // Initialize FS directory structure
                    const { initializeFS } = await import('./fs/init.js');
                    await initializeFS(adapter, ROOT_USER_ID);

                    db.exec('COMMIT');
                } catch (error) {
                    db.exec('ROLLBACK');
                    throw error;
                }
            } else {
                // PostgreSQL: Execute schema + seed
                await adapter.beginTransaction();

                try {
                    // Schema includes seed data (models, fields metadata)
                    await adapter.query(TENANT_SCHEMA_POSTGRESQL);

                    // Always create root user (auth='root', id=ROOT_USER_ID)
                    await adapter.query(
                        `INSERT INTO users (id, name, auth, access)
                         VALUES ($1, 'Root User', 'root', 'root')
                         ON CONFLICT (auth) DO NOTHING`,
                        [ROOT_USER_ID]
                    );

                    // If owner is not root, create separate owner user
                    if (ownerUsername !== 'root') {
                        await adapter.query(
                            `INSERT INTO users (id, name, auth, access)
                             VALUES ($1, $2, $3, 'root')
                             ON CONFLICT (auth) DO NOTHING`,
                            [ownerUserId, ownerUsername, ownerUsername]
                        );
                    }

                    // Initialize FS directory structure
                    const { initializeFS } = await import('./fs/init.js');
                    await initializeFS(adapter, ROOT_USER_ID);

                    await adapter.commit();
                } catch (error) {
                    await adapter.rollback();
                    throw error;
                }
            }
        } finally {
            await adapter.disconnect();
        }

        return ownerUserId;
    }
}
