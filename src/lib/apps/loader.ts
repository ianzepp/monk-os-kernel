/**
 * App Package Loader
 *
 * Dynamically loads installed @monk-app/* app packages.
 * App packages export a createApp() function that returns a Hono app.
 *
 * Model namespace is determined per-model via the `external` field:
 * - external: true  - Model installed in app's namespace (shared infrastructure)
 * - external: false - Model installed in user's tenant (default, user data)
 *
 * Apps can have models in both namespaces (hybrid apps). External models are
 * installed at app startup, tenant models are installed on first user request.
 *
 * Model definitions are loaded from YAML files in the package's models/ directory.
 * Each .yaml file defines one model with its fields.
 *
 * Package scopes:
 * - @monk/* - core packages (formatters, bindings)
 * - @monk-app/* - app packages (mcp, grids, etc.)
 */

import type { Context } from 'hono';
import type { Hono } from 'hono';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseConnection } from '@src/lib/database-connection.js';
import { DatabaseNaming } from '@src/lib/database-naming.js';
import { NamespaceManager } from '@src/lib/namespace-manager.js';
import { Infrastructure } from '@src/lib/infrastructure.js';
import { JWTGenerator, type JWTPayload } from '@src/lib/jwt-generator.js';
import { YamlFormatter } from '@src/lib/formatters/yaml.js';
import { toBytes } from '@monk/common';
import type { SystemInit } from '@src/lib/system.js';
import { runTransaction } from '@src/lib/transaction.js';
import { createInProcessClient, type InProcessClient } from './in-process-client.js';

// App token expiry: 1 year (in seconds)
const APP_TOKEN_EXPIRY = 365 * 24 * 60 * 60;

/**
 * App configuration from app.yaml
 *
 * The `scope` field is deprecated - model namespace is now determined
 * per-model via the `external` field in model YAML files.
 */
export interface AppConfig {
    name: string;
    /** @deprecated Use per-model `external` field instead */
    scope?: 'app' | 'tenant';
    description?: string;
}

// Cache for app configs
const appConfigCache = new Map<string, AppConfig>();

/**
 * Load app configuration from app.yaml
 */
export async function loadAppConfig(appName: string): Promise<AppConfig> {
    // Check cache first
    const cached = appConfigCache.get(appName);
    if (cached) return cached;

    try {
        const packageUrl = import.meta.resolve(`@monk-app/${appName}`);
        const packagePath = fileURLToPath(packageUrl);
        const configPath = join(dirname(packagePath), '..', 'app.yaml');

        const content = await readFile(configPath, 'utf-8');
        const config = YamlFormatter.decode(toBytes(content)) as AppConfig;

        // Validate required fields
        if (!config.name) config.name = appName;
        // scope is now optional - determined per-model via external field

        appConfigCache.set(appName, config);
        return config;
    } catch (error) {
        // No app.yaml - use defaults
        const defaultConfig: AppConfig = {
            name: appName,
        };
        appConfigCache.set(appName, defaultConfig);
        return defaultConfig;
    }
}

/**
 * Context passed to app createApp() function
 */
export interface AppContext {
    /** In-process client for API calls (uses app's JWT token) */
    client: InProcessClient;
    /** App's JWT token for API authentication */
    token: string;
    /** App name (e.g., 'mcp') */
    appName: string;
    /** Full tenant name (e.g., '@monk/mcp') */
    tenantName: string;
    /** Reference to main Hono app for in-process routing */
    honoApp: Hono;
}

export type AppFactory = (context: AppContext) => Hono | Promise<Hono>;

/**
 * Register or retrieve an app tenant.
 *
 * App tenants:
 * - Use namespace prefix 'ns_app_' instead of 'ns_tenant_'
 * - Have allowed_ips restricted to localhost (127.0.0.1, ::1)
 * - Cannot be logged into via /auth/login from external IPs
 *
 * @param appName - App name without @monk/ prefix (e.g., 'mcp')
 * @returns JWT token for the app's root user
 */
export async function registerAppTenant(appName: string): Promise<{
    token: string;
    tenantName: string;
    dbName: string;
    nsName: string;
    userId: string;
}> {
    const tenantName = `@monk/${appName}`;
    const mainPool = DatabaseConnection.getMainPool();

    // Check if tenant already exists
    const existingTenant = await mainPool.query(
        'SELECT id, database, schema FROM tenants WHERE name = $1 AND deleted_at IS NULL',
        [tenantName]
    );

    if (existingTenant.rows.length > 0) {
        // Tenant exists - get user and generate token
        const { database: dbName, schema: nsName } = existingTenant.rows[0];

        // Get root user from tenant namespace
        const userResult = await DatabaseConnection.queryInNamespace(
            dbName,
            nsName,
            'SELECT id, auth, access, access_read, access_edit, access_full FROM users WHERE auth = $1 AND deleted_at IS NULL',
            ['root']
        );

        if (userResult.rows.length === 0) {
            throw new Error(`App tenant ${tenantName} exists but has no root user`);
        }

        const user = userResult.rows[0];

        // Generate long-lived token
        const token = await JWTGenerator.fromUserAndTenant(
            user,
            { name: tenantName, db_type: 'postgresql', database: dbName, schema: nsName },
            APP_TOKEN_EXPIRY
        );

        console.info(`App tenant exists: ${tenantName}`);

        return { token, tenantName, dbName, nsName, userId: user.id };
    }

    // Create new app tenant
    console.info(`Creating app tenant: ${tenantName}`);

    const dbName = 'db_main';
    const nsName = DatabaseNaming.generateAppNsName(appName);

    // Check namespace doesn't already exist
    if (await NamespaceManager.namespaceExists(dbName, nsName, 'postgresql')) {
        throw new Error(`Namespace ${nsName} already exists but tenant record missing`);
    }

    // Use transaction to ensure namespace + tenant are created atomically
    await mainPool.query('BEGIN');

    try {
        // Create namespace
        await NamespaceManager.createNamespace(dbName, nsName, 'postgresql');

        // Deploy tenant schema (models, fields, users, filters) and create root user
        // Returns ROOT_USER_ID since we pass 'root' as owner
        const ownerUserId = await Infrastructure.deployTenantSchema('postgresql', dbName, nsName, 'root');

        // Register tenant with IP restrictions
        await mainPool.query(
            `INSERT INTO tenants (name, db_type, database, schema, description, source_template, owner_id, host, is_active, allowed_ips)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                tenantName,
                'postgresql',
                dbName,
                nsName,
                `App tenant for @monk/${appName}`,
                'system',
                ownerUserId,
                'localhost',
                true,
                ['127.0.0.1', '::1'], // Localhost only
            ]
        );

        await mainPool.query('COMMIT');

        // Generate long-lived token for owner (ROOT_USER_ID for app tenants)
        const token = await JWTGenerator.forRootUser(
            ownerUserId,
            tenantName,
            dbName,
            nsName,
            APP_TOKEN_EXPIRY
        );

        console.info(`Created app tenant: ${tenantName}`);

        return { token, tenantName, dbName, nsName, userId: ownerUserId };

    } catch (error) {
        // Rollback transaction on failure
        await mainPool.query('ROLLBACK');

        // Cleanup namespace (may have been created before transaction started)
        try {
            await NamespaceManager.dropNamespace(dbName, nsName, 'postgresql');
        } catch (cleanupError) {
            console.warn(`Failed to cleanup namespace ${nsName}:`, cleanupError);
        }
        throw error;
    }
}

/**
 * Model definition for app registration.
 * Field definitions match the Infrastructure tenant schema's fields table.
 */
export interface AppModelDefinition {
    model_name: string;
    description?: string;
    /**
     * If true, model is installed in app's namespace (shared infrastructure).
     * If false (default), model is installed in user's tenant (user data).
     */
    external?: boolean;
    fields: Array<{
        field_name: string;
        type: string;
        required?: boolean;
        default_value?: string;
        description?: string;
    }>;
}

/**
 * Register models for an app in a target namespace.
 *
 * Uses runTransaction for proper transaction lifecycle management.
 * This is idempotent - creates models if they don't exist.
 *
 * @param dbType - Database type (postgresql or sqlite)
 * @param dbName - Database name
 * @param nsName - Namespace name
 * @param userId - User ID for the operation
 * @param tenantName - Tenant name for logging
 * @param appName - App name for logging
 * @param models - Array of model definitions to register
 */
export async function registerAppModels(
    dbType: 'postgresql' | 'sqlite',
    dbName: string,
    nsName: string,
    userId: string,
    tenantName: string,
    appName: string,
    models: AppModelDefinition[]
): Promise<void> {
    const systemInit: SystemInit = {
        dbType,
        dbName,
        nsName,
        userId,
        access: 'root',
        tenant: tenantName,
        isSudoToken: true, // App model registration runs with sudo
    };

    await runTransaction(systemInit, async (system) => {
        // Register each model
        for (const modelDef of models) {
            const { model_name, description, external, fields } = modelDef;

            // Check if model exists
            const existing = await system.describe.models.selectOne(
                { where: { model_name } },
                { context: 'system' }
            );

            if (!existing) {
                // Create model with external flag
                console.info(`Creating model ${model_name} for app ${appName} in ${tenantName} (external: ${external ?? false})`);
                await system.describe.models.createOne({
                    model_name,
                    description,
                    external: external ?? false,
                });

                // Create fields
                for (const field of fields) {
                    await system.describe.fields.createOne({
                        model_name,
                        ...field,
                    });
                }
            }
        }
    }, {
        logContext: { appName, tenantName, operation: 'registerAppModels' },
    });
}

/**
 * Load model definitions from YAML files in the package's models/ directory.
 *
 * Each .yaml file should contain a single model definition:
 * ```yaml
 * model_name: todos
 * description: Todo items
 * fields:
 *   - field_name: title
 *     type: text
 *     required: true
 * ```
 *
 * @param packagePath - Path to the package directory (dist/ for compiled packages)
 * @param appName - App name for logging
 * @returns Array of model definitions
 */
async function loadAppModelsFromYaml(packagePath: string, appName: string): Promise<AppModelDefinition[]> {
    const models: AppModelDefinition[] = [];

    // Look for models/ directory relative to package path
    // For compiled packages: node_modules/@monk-app/todos/dist/index.js → models/ is at ../models/
    const modelsDir = join(dirname(packagePath), '..', 'models');

    try {
        const entries = await readdir(modelsDir, { withFileTypes: true });
        const yamlFiles = entries.filter(e => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')));

        for (const file of yamlFiles) {
            const filePath = join(modelsDir, file.name);
            const content = await readFile(filePath, 'utf-8');
            const model = YamlFormatter.decode(toBytes(content)) as AppModelDefinition;

            if (!model.model_name) {
                console.warn(`YAML model file ${file.name} missing model_name, skipping`);
                continue;
            }

            models.push(model);
            console.info(`Loaded model definition: ${model.model_name} from ${file.name}`);
        }
    } catch (error) {
        // No models directory - that's fine, app may not need models
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`Failed to load models for @monk-app/${appName}:`, error);
        }
    }

    return models;
}

/**
 * Load an app-scoped app package (has its own tenant for internal data).
 *
 * Used for apps like MCP that need their own storage for sessions, config, etc.
 * The app's in-process client uses the app's token by default.
 *
 * @param appName - App name without @monk/ prefix (e.g., 'mcp')
 * @param honoApp - Main Hono app instance for in-process client
 * @returns Initialized Hono app for the package, or null if not installed
 */
export async function loadAppScopedApp(appName: string, honoApp: Hono): Promise<Hono | null> {
    try {
        // Resolve package path to find models directory
        const packageUrl = import.meta.resolve(`@monk-app/${appName}`);
        const packagePath = fileURLToPath(packageUrl);

        // Try to import the package from @monk-app/* scope
        const mod = await import(`@monk-app/${appName}`);

        if (typeof mod.createApp !== 'function') {
            console.warn(`App package @monk-app/${appName} does not export createApp()`);
            return null;
        }

        // Register/retrieve app tenant
        const { token, tenantName, dbName, nsName, userId } = await registerAppTenant(appName);

        // Create a mock context for the in-process client
        // The client will use the app's token for all requests
        const mockContext = {
            req: {
                header: (name: string) => {
                    if (name.toLowerCase() === 'authorization') {
                        return `Bearer ${token}`;
                    }
                    return undefined;
                },
            },
        } as any;

        const client = createInProcessClient(mockContext, honoApp);

        // Build app context
        const appContext: AppContext = {
            client,
            token,
            appName,
            tenantName,
            honoApp,
        };

        // Load and register app models from YAML files
        const models = await loadAppModelsFromYaml(packagePath, appName);
        if (models.length > 0) {
            await registerAppModels('postgresql', dbName, nsName, userId, tenantName, appName, models);
        }

        // Call the app's createApp function
        const app = await mod.createApp(appContext);

        return app;

    } catch (error) {
        // Package not installed - skip silently
        if (error instanceof Error && !error.message.includes('Cannot find package')) {
            console.warn(`Failed to load @monk-app/${appName}:`, error.message);
        }
        return null;
    }
}

// Cache for app instances (app code is stateless, can be shared)
const appInstanceCache = new Map<string, Hono>();

// Cache for loaded model definitions per app
const appModelsCache = new Map<string, AppModelDefinition[]>();

// Track which apps have external models installed in app namespace
const externalModelsInstalledCache = new Set<string>();

// Track which tenants have tenant models installed for each app
const tenantModelsInstalledCache = new Map<string, Set<string>>();

// Cache for app tenant credentials (for apps with external models)
const appTenantCache = new Map<string, {
    token: string;
    tenantName: string;
    dbName: string;
    nsName: string;
    userId: string;
}>();

/**
 * Separate models into external (app namespace) and tenant (user namespace) groups.
 */
function separateModelsByScope(models: AppModelDefinition[]): {
    externalModels: AppModelDefinition[];
    tenantModels: AppModelDefinition[];
} {
    const externalModels: AppModelDefinition[] = [];
    const tenantModels: AppModelDefinition[] = [];

    for (const model of models) {
        if (model.external) {
            externalModels.push(model);
        } else {
            tenantModels.push(model);
        }
    }

    return { externalModels, tenantModels };
}

/**
 * Check if an app has external models (requires app tenant).
 */
export function appHasExternalModels(appName: string): boolean {
    const models = appModelsCache.get(appName);
    if (!models) return false;
    return models.some(m => m.external);
}

/**
 * Check if an app has tenant models (installed per-user).
 */
export function appHasTenantModels(appName: string): boolean {
    const models = appModelsCache.get(appName);
    if (!models) return false;
    return models.some(m => !m.external);
}

/**
 * Load an app package with hybrid model support.
 *
 * Handles apps that may have models in both namespaces:
 * - external: true models → installed in app's namespace (once at startup)
 * - external: false models → installed in user's tenant (per-tenant)
 *
 * @param appName - App name without @monk/ prefix (e.g., 'todos', 'extracts')
 * @param honoApp - Main Hono app instance for in-process client
 * @param userContext - Original request context (may have jwtPayload for tenant models)
 * @returns Initialized Hono app for the package, or null if not installed
 */
export async function loadHybridApp(
    appName: string,
    honoApp: Hono,
    userContext?: Context
): Promise<Hono | null> {
    try {
        // Step 1: Load app instance and model definitions (cached)
        let appInstance: Hono | null = appInstanceCache.get(appName) || null;
        let models: AppModelDefinition[] = appModelsCache.get(appName) || [];

        if (!appInstance) {
            // Resolve package path to find models directory
            const packageUrl = import.meta.resolve(`@monk-app/${appName}`);
            const packagePath = fileURLToPath(packageUrl);

            // Try to import the package
            const mod = await import(`@monk-app/${appName}`);

            if (typeof mod.createApp !== 'function') {
                console.warn(`App package @monk-app/${appName} does not export createApp()`);
                return null;
            }

            // Load models from YAML
            models = await loadAppModelsFromYaml(packagePath, appName);
            appModelsCache.set(appName, models);

            // Create app context (client is per-request in tenant-scoped apps)
            const appContext: AppContext = {
                client: null as any,
                token: '',
                appName,
                tenantName: '',
                honoApp,
            };

            // Create the app instance (stateless, can be cached)
            const created = await mod.createApp(appContext);
            appInstance = created;
            appInstanceCache.set(appName, created);

            console.info(`Loaded app: @monk-app/${appName}`);
        }

        // Step 2: Separate models by scope
        const { externalModels, tenantModels } = separateModelsByScope(models);

        // Step 3: Install external models in app namespace (once per app)
        if (externalModels.length > 0 && !externalModelsInstalledCache.has(appName)) {
            // Register app tenant if not already done
            let appTenant = appTenantCache.get(appName);
            if (!appTenant) {
                appTenant = await registerAppTenant(appName);
                appTenantCache.set(appName, appTenant);
            }

            // Install external models in app's namespace
            await registerAppModels(
                'postgresql',
                appTenant.dbName,
                appTenant.nsName,
                appTenant.userId,
                appTenant.tenantName,
                appName,
                externalModels
            );

            externalModelsInstalledCache.add(appName);
            console.info(`Installed ${externalModels.length} external model(s) for @monk-app/${appName}`);
        }

        // Step 4: Install tenant models in user's namespace (per-tenant)
        if (tenantModels.length > 0 && userContext) {
            const jwtPayload = userContext.get('jwtPayload') as JWTPayload | undefined;
            if (jwtPayload) {
                const tenantKey = `${jwtPayload.db}:${jwtPayload.ns}`;
                const installedTenants = tenantModelsInstalledCache.get(appName) || new Set();

                if (!installedTenants.has(tenantKey)) {
                    // Install tenant models in user's namespace
                    await registerAppModels(
                        jwtPayload.db_type,
                        jwtPayload.db,
                        jwtPayload.ns,
                        jwtPayload.sub,
                        jwtPayload.tenant,
                        appName,
                        tenantModels
                    );

                    installedTenants.add(tenantKey);
                    tenantModelsInstalledCache.set(appName, installedTenants);
                    console.info(`Installed ${tenantModels.length} tenant model(s) for @monk-app/${appName} in ${jwtPayload.tenant}`);
                }
            }
        }

        return appInstance;

    } catch (error) {
        if (error instanceof Error && !error.message.includes('Cannot find package')) {
            console.warn(`Failed to load @monk-app/${appName}:`, error.message);
        }
        return null;
    }
}

/**
 * Load a tenant-scoped app package (models installed in user's tenant).
 *
 * @deprecated Use loadHybridApp instead - supports both external and tenant models.
 */
export async function loadTenantScopedApp(
    appName: string,
    honoApp: Hono,
    userContext: Context
): Promise<Hono | null> {
    return loadHybridApp(appName, honoApp, userContext);
}

/**
 * Load an app package.
 *
 * @deprecated Use loadHybridApp instead - handles all model scopes.
 */
export async function loadApp(appName: string, honoApp: Hono): Promise<Hono | null> {
    return loadHybridApp(appName, honoApp);
}

/**
 * Discover installed @monk-app/* packages by scanning node_modules.
 *
 * @returns Array of app names (without @monk-app/ prefix)
 */
export async function discoverApps(): Promise<string[]> {
    const { readdir } = await import('fs/promises');
    const { join } = await import('path');

    const scopeDir = join(process.cwd(), 'node_modules', '@monk-app');

    try {
        const entries = await readdir(scopeDir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
            .map(entry => entry.name);
    } catch {
        // @monk-app directory doesn't exist - no apps installed
        return [];
    }
}
