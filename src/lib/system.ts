import type { Context } from 'hono';
import type { FS } from '@src/lib/fs/index.js';
import { createFS } from '@src/lib/fs/factory.js';
import { Database } from '@src/lib/database.js';
import { Describe } from '@src/lib/describe.js';
import { AI } from '@src/lib/ai.js';
import { NamespaceCacheManager, NamespaceCache } from '@src/lib/namespace-cache.js';
import type { SystemContext, SystemOptions, UserInfo } from '@src/lib/system-context-types.js';
import type { DatabaseAdapter, DatabaseType } from '@src/lib/database/adapter.js';
import type { JWTPayload } from '@src/lib/jwt-generator.js';

/**
 * Initialization parameters for System.
 * Can be constructed from JWTPayload or provided directly for internal operations.
 */
export interface SystemInit {
    /** Database backend type */
    dbType: DatabaseType;
    /** Database name */
    dbName: string;
    /** Namespace/schema name */
    nsName: string;
    /** User ID */
    userId: string;
    /** Username (for home directory mount) */
    username?: string;
    /** Access level */
    access: string;
    /** Tenant name */
    tenant: string;
    /** ACL read access */
    accessRead?: string[];
    /** ACL edit access */
    accessEdit?: string[];
    /** ACL full access */
    accessFull?: string[];
    /** Whether this is a sudo token */
    isSudoToken?: boolean;
    /** Correlation ID for request tracing */
    correlationId?: string;
}

/**
 * Create SystemInit from a JWTPayload.
 * This is the bridge between JWT authentication and System initialization.
 */
export function systemInitFromJWT(payload: JWTPayload, correlationId?: string): SystemInit {
    return {
        dbType: payload.db_type || 'postgresql',
        dbName: payload.db,
        nsName: payload.ns,
        userId: payload.user_id || payload.sub,
        username: payload.username,
        access: payload.access,
        tenant: payload.tenant,
        accessRead: payload.access_read || [],
        accessEdit: payload.access_edit || [],
        accessFull: payload.access_full || [],
        isSudoToken: payload.is_sudo === true,
        correlationId,
    };
}

/**
 * System class - Per-request context management
 *
 * Provides access to properly contextualized database operations.
 * Can be initialized from JWT payload (HTTP requests) or directly (internal operations).
 *
 * Implements SystemContext interface to provide business context to other components
 * while breaking circular dependencies through dependency injection.
 */
export class System implements SystemContext {
    public readonly userId: string;
    public readonly options: Readonly<SystemOptions>;
    public readonly correlationId: string;

    // Database backend type (postgresql or sqlite)
    public readonly dbType: DatabaseType;

    // Database and namespace names
    public readonly dbName: string;
    public readonly nsName: string;

    // Authentication context
    public readonly access: string;
    public readonly tenant: string;
    public readonly username?: string;
    public readonly accessRead: string[];
    public readonly accessEdit: string[];
    public readonly accessFull: string[];

    // Sudo state
    private readonly _isSudoToken: boolean;
    private _asSudo: boolean = false;

    // Database adapter - set by runTransaction() for query execution
    // Provides abstraction layer for PostgreSQL and SQLite backends
    public adapter: DatabaseAdapter | null = null;

    // System services
    public readonly database: Database;
    public readonly describe!: Describe;
    public readonly ai: AI;

    // Namespace cache bound to this request's db:ns
    public readonly namespace: NamespaceCache;

    // Filesystem
    public readonly fs: FS;

    /**
     * @deprecated Use context-free constructor with SystemInit instead.
     * This property is kept for backward compatibility during migration.
     */
    public readonly context: Context | null;

    constructor(init: SystemInit, options?: SystemOptions);
    /** @deprecated Use SystemInit constructor instead */
    constructor(context: Context, options?: SystemOptions);
    constructor(initOrContext: SystemInit | Context, options: SystemOptions = {}) {
        // Detect which constructor form is being used
        if (this.isHonoContext(initOrContext)) {
            // Legacy: Hono Context constructor
            const c = initOrContext;
            this.context = c;

            this.dbType = (c.get('dbType') as DatabaseType) || 'postgresql';
            this.dbName = c.get('dbName') as string;
            this.nsName = c.get('nsName') as string;
            this.userId = c.get('userId') || 'anonymous';

            const payload = c.get('jwtPayload') as JWTPayload | undefined;
            this.access = payload?.access || 'user';
            this.tenant = payload?.tenant || 'unknown';
            this.accessRead = c.get('accessReadIds') || payload?.access_read || [];
            this.accessEdit = c.get('accessEditIds') || payload?.access_edit || [];
            this.accessFull = c.get('accessFullIds') || payload?.access_full || [];
            this._isSudoToken = payload?.is_sudo === true;

            this.correlationId = c.req.header('x-request-id') || this.generateCorrelationId();
        } else {
            // New: SystemInit constructor
            const init = initOrContext;
            this.context = null;

            this.dbType = init.dbType;
            this.dbName = init.dbName;
            this.nsName = init.nsName;
            this.userId = init.userId;
            this.username = init.username;
            this.access = init.access;
            this.tenant = init.tenant;
            this.accessRead = init.accessRead || [];
            this.accessEdit = init.accessEdit || [];
            this.accessFull = init.accessFull || [];
            this._isSudoToken = init.isSudoToken === true;

            this.correlationId = init.correlationId || this.generateCorrelationId();
        }

        // Initialize service instances with clean dependency injection
        // Note: system.adapter is set by runTransaction() before any database operations
        this.database = new Database(this);
        this.describe = new Describe(this);
        this.ai = new AI(this);
        this.fs = createFS(this, { username: this.username });

        // Bind namespace cache
        if (this.dbName && this.nsName) {
            this.namespace = NamespaceCacheManager.getInstance().getNamespaceCache(this.dbName, this.nsName);
        } else {
            // For auth routes that don't have tenant context, create a placeholder
            this.namespace = null as any;
        }

        // Store query options as read-only
        this.options = Object.freeze({ ...options });
    }

    /**
     * Type guard to detect Hono Context vs SystemInit
     */
    private isHonoContext(obj: any): obj is Context {
        return obj && typeof obj.get === 'function' && typeof obj.set === 'function' && obj.req;
    }

    /**
     * Check if the current operation has sudo access.
     * Sudo access is granted via:
     * 1. Root access level (automatic sudo)
     * 2. Explicit sudo token (is_sudo=true in JWT)
     * 3. Self-service sudo flag (set via setAsSudo)
     */
    isSudo(): boolean {
        return this.isRoot() || this._isSudoToken || this._asSudo;
    }

    /**
     * Set the self-service sudo flag.
     * Used by withSelfServiceSudo() for temporary sudo elevation.
     */
    setAsSudo(value: boolean): void {
        this._asSudo = value;
    }

    /**
     * Check if self-service sudo is currently active.
     */
    isAsSudo(): boolean {
        return this._asSudo;
    }

    /**
     * Check if the current user has root access level
     * Implementation of SystemContext interface
     */
    isRoot(): boolean {
        return this.access === 'root';
    }

    /**
     * Get user information from the request context
     * Implementation of SystemContext interface
     */
    getUser(): UserInfo {
        return {
            id: this.userId,
            tenant: this.tenant,
            role: this.access,
            accessRead: this.accessRead,
            accessEdit: this.accessEdit,
            accessFull: this.accessFull,
        };
    }

    /**
     * Generate correlation ID for request tracking
     */
    private generateCorrelationId(): string {
        return 'req-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    }
}
