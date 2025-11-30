/**
 * System Context Types
 *
 * Defines the context interface needed by business logic components,
 * breaking circular dependencies while maintaining clean architecture.
 */

import type { Context } from 'hono';
import type { DatabaseAdapter, DatabaseType } from './database/adapter.js';

/**
 * System options for controlling query behavior
 */
export interface SystemOptions {
    /** Include trashed records (soft deletes) in query results */
    trashed?: boolean;
    /** Include permanently deleted records in query results (root access only) */
    deleted?: boolean;
}

/**
 * User information extracted from request context
 */
export interface UserInfo {
    id: string;
    tenant: string;
    role: string;
    accessRead: string[];
    accessEdit: string[];
    accessFull: string[];
}

/**
 * System Context - Per-request context for database operations
 *
 * Provides business context (user, options) and infrastructure (db, tx, services)
 * to all database operations, models, and observers.
 *
 * Design principles:
 * - Per-request instance pattern (not singleton)
 * - Dependency injection to break circular dependencies
 * - Contains both business context and infrastructure concerns
 * - Can be created from JWT payload (HTTP) or directly (internal operations)
 */
export interface SystemContext {
    /** User ID from authentication context */
    readonly userId: string;

    /** Query behavior options (soft delete handling, etc.) */
    readonly options: Readonly<SystemOptions>;

    /**
     * Hono request context for accessing request/response and context variables.
     * Null for internal operations that don't originate from HTTP requests.
     * @deprecated Access properties directly instead of through context
     */
    readonly context: Context | null;

    /** Database backend type (postgresql or sqlite) from JWT */
    readonly dbType: DatabaseType;

    /** Database name */
    readonly dbName: string;

    /** Namespace/schema name */
    readonly nsName: string;

    /** Access level (root, full, edit, read, deny) */
    readonly access: string;

    /** Tenant name */
    readonly tenant: string;

    /** Database adapter for query execution
     *  Set by runTransaction() before any database operations execute
     *  Provides abstraction layer for PostgreSQL and SQLite backends */
    adapter: DatabaseAdapter | null;

    /** Database instance for high-level operations */
    readonly database: any; // Avoid importing Database class to prevent circular deps

    /** Describe instance for model operations */
    readonly describe: any; // Avoid importing Describe class to prevent circular deps

    /** Namespace cache for model/field metadata (bound to db:ns from JWT)
     *  Provides schema-aware caching that isolates tenant data properly */
    readonly namespace: any; // Avoid importing NamespaceCache to prevent circular deps

    /**
     * Get comprehensive user information from the request context
     */
    getUser(): UserInfo;

    /**
     * Check if the current user has root access level
     */
    isRoot(): boolean;

    /**
     * Check if the current operation has sudo access.
     * Sudo access is granted via:
     * 1. Root access level (automatic sudo)
     * 2. Explicit sudo token (is_sudo=true in JWT)
     * 3. Self-service sudo flag (set via setAsSudo)
     */
    isSudo(): boolean;
}
