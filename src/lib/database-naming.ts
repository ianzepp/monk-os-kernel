import { createHash, randomBytes } from 'crypto';

/**
 * Database Naming Service
 *
 * Centralizes all database and namespace (schema) name generation logic.
 * This module provides consistent hashing and naming across the application.
 *
 * Architecture: Hybrid Database + Schema Model
 * - Databases: db_main, db_test, db_premium_*, etc. (shared or dedicated)
 * - Namespaces: ns_tenant_*, ns_test_*, ns_sandbox_* (isolation within databases)
 *
 * Current implementation uses SHA256 hashing for enterprise mode, which ensures:
 * - Consistent names regardless of Unicode variations
 * - Protection from reserved name conflicts
 * - Name privacy (tenant name not exposed in namespace name)
 * - No collision risk (8 hex chars = 32 bits = 4.3 billion combinations)
 */

/**
 * Tenant database naming modes
 *
 * Note: Previously supported PERSONAL mode (human-readable names) was removed
 * to ensure database name isolation across environments and avoid naming conflicts.
 */
export enum TenantNamingMode {
    /**
     * Enterprise mode: Uses SHA256 hash of tenant name
     * Format: ns_tenant_<8-char-hex>
     * Example: "My Company" → "ns_tenant_a1b2c3d4"
     */
    ENTERPRISE = 'enterprise',
}

/**
 * Database naming service
 *
 * Provides unified database name generation for tenant databases.
 * Replaces duplicate implementations in TenantService and DatabaseTemplate.
 */
export class DatabaseNaming {
    /**
     * Generate tenant database name (LEGACY - kept for backward compatibility)
     *
     * @deprecated Use generateTenantNsName() for new hybrid database+schema architecture
     *
     * Uses SHA256 hashing to ensure:
     * - Consistent database names regardless of Unicode variations
     * - Protection from reserved name conflicts
     * - Database name privacy (tenant name not exposed in DB name)
     * - No collision risk (8 hex chars = 32 bits = 4.3 billion combinations)
     *
     * @param tenantName - User-facing tenant name (any Unicode string)
     * @param mode - Naming mode (kept for backward compatibility, always uses ENTERPRISE)
     * @returns PostgreSQL database name with tenant_ prefix
     */
    static generateDatabaseName(
        tenantName: string,
        mode: TenantNamingMode = TenantNamingMode.ENTERPRISE,
    ): string {
        const normalizedName = tenantName.trim().normalize('NFC');
        const hash = createHash('sha256').update(normalizedName, 'utf8').digest('hex').substring(0, 8);
        return `tenant_${hash}`;
    }

    /**
     * Generate tenant namespace (schema) name
     *
     * Uses SHA256 hashing to ensure:
     * - Consistent namespace names regardless of Unicode variations
     * - Protection from reserved name conflicts
     * - Namespace privacy (tenant name not exposed)
     * - No collision risk (8 hex chars = 32 bits = 4.3 billion combinations)
     * - Environment isolation (same tenant name in dev/test/prod gets same hash)
     *
     * Algorithm:
     * 1. Normalize Unicode input (NFC normalization)
     * 2. Trim whitespace
     * 3. Generate SHA256 hash
     * 4. Take first 8 hex characters
     * 5. Add 'ns_tenant_' prefix
     *
     * Examples:
     *   "My Cool App" → "ns_tenant_a1b2c3d4"
     *   "测试应用" → "ns_tenant_f9e8d7c6"
     *   "🚀 Rocket" → "ns_tenant_d4c9b8a7"
     *
     * @param tenantName - User-facing tenant name (any Unicode string)
     * @returns PostgreSQL schema name with ns_tenant_ prefix
     */
    static generateTenantNsName(tenantName: string): string {
        // Normalize Unicode for consistent hashing
        // NFC (Canonical Decomposition, followed by Canonical Composition)
        // ensures that "é" and "e + ´" produce the same hash
        const normalizedName = tenantName.trim().normalize('NFC');

        // Generate SHA256 hash and take first 8 characters (32 bits)
        // 8 hex chars = 32 bits = 4.3 billion combinations
        const hash = createHash('sha256').update(normalizedName, 'utf8').digest('hex').substring(0, 8);

        // Add prefix for tenant namespaces
        return `ns_tenant_${hash}`;
    }

    /**
     * Generate test namespace (schema) name
     *
     * Uses random bytes for uniqueness across parallel test execution.
     *
     * Format: ns_test_<8-char-hex>
     * Example: "ns_test_a1b2c3d4"
     *
     * @returns PostgreSQL schema name with ns_test_ prefix
     */
    static generateTestNsName(): string {
        // Use random bytes for test namespaces (4 bytes = 8 hex chars)
        const hash = randomBytes(4).toString('hex');
        return `ns_test_${hash}`;
    }

    /**
     * Generate sandbox namespace (schema) name
     *
     * Uses random bytes for uniqueness.
     *
     * Format: ns_sandbox_<8-char-hex>
     * Example: "ns_sandbox_xyz78901"
     *
     * @returns PostgreSQL schema name with ns_sandbox_ prefix
     */
    static generateSandboxNsName(): string {
        // Use random bytes for sandbox namespaces (4 bytes = 8 hex chars)
        const hash = randomBytes(4).toString('hex');
        return `ns_sandbox_${hash}`;
    }

    /**
     * Generate app namespace (schema) name
     *
     * Used for @monk/* app packages that need their own isolated tenant.
     * Uses SHA256 hashing for consistent naming across server restarts.
     *
     * Format: ns_app_<8-char-hex>
     * Example: "mcp" → "ns_app_a1b2c3d4"
     *
     * @param appName - App name without @monk/ prefix (e.g., 'mcp')
     * @returns PostgreSQL schema name with ns_app_ prefix
     */
    static generateAppNsName(appName: string): string {
        // Normalize and hash for consistent naming
        const normalizedName = appName.trim().normalize('NFC');
        const hash = createHash('sha256').update(normalizedName, 'utf8').digest('hex').substring(0, 8);
        return `ns_app_${hash}`;
    }

    /**
     * Check if a database name follows tenant naming conventions
     *
     * Valid prefixes:
     * - tenant_ (production tenants)
     * - test_ (test databases)
     * - test_template_ (test templates)
     *
     * @param databaseName - Database name to check
     * @returns true if name follows conventions
     */
    static isTenantDatabase(databaseName: string): boolean {
        return (
            databaseName.startsWith('tenant_') ||
            databaseName.startsWith('test_') ||
            databaseName.startsWith('test_template_')
        );
    }

    /**
     * Extract hash from database name
     *
     * @param databaseName - Database name in format tenant_<hash>
     * @returns Hash portion, or null if not a valid tenant database
     */
    static extractHash(databaseName: string): string | null {
        if (!databaseName.startsWith('tenant_')) {
            return null;
        }

        const hash = databaseName.substring('tenant_'.length);
        return hash.length === 8 && /^[a-f0-9]+$/.test(hash) ? hash : null;
    }

    /**
     * Check if a namespace name follows tenant namespace conventions
     *
     * Valid prefixes:
     * - ns_tenant_ (production tenants)
     * - ns_test_ (test namespaces)
     * - ns_sandbox_ (sandbox namespaces)
     * - ns_app_ (app package tenants)
     *
     * @param nsName - Namespace name to check
     * @returns true if name follows conventions
     */
    static isTenantNamespace(nsName: string): boolean {
        return (
            nsName.startsWith('ns_tenant_') ||
            nsName.startsWith('ns_test_') ||
            nsName.startsWith('ns_sandbox_') ||
            nsName.startsWith('ns_app_')
        );
    }

    /**
     * Validate database name format
     *
     * Ensures database name:
     * - Is a non-empty string
     * - Contains only alphanumeric and underscore characters
     * - Follows PostgreSQL identifier rules
     *
     * @param databaseName - Database name to validate
     * @throws Error if validation fails
     */
    static validateDatabaseName(databaseName: string): void {
        if (typeof databaseName !== 'string') {
            throw new Error('Database name must be a string');
        }

        const trimmed = databaseName.trim();

        if (!trimmed) {
            throw new Error('Database name cannot be empty');
        }

        // PostgreSQL identifiers: alphanumeric + underscore only
        // This prevents SQL injection via database names
        if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
            throw new Error(`Database name "${databaseName}" contains invalid characters`);
        }

        // PostgreSQL max identifier length is 63 bytes
        if (trimmed.length > 63) {
            throw new Error(`Database name "${databaseName}" exceeds PostgreSQL limit (63 chars)`);
        }
    }

    /**
     * Validate namespace (schema) name format
     *
     * Ensures namespace name:
     * - Is a non-empty string
     * - Contains only alphanumeric and underscore characters
     * - Follows PostgreSQL identifier rules
     * - Prevents SQL injection
     *
     * @param nsName - Namespace name to validate
     * @throws Error if validation fails
     */
    static validateNamespaceName(nsName: string): void {
        if (typeof nsName !== 'string') {
            throw new Error('Namespace name must be a string');
        }

        const trimmed = nsName.trim();

        if (!trimmed) {
            throw new Error('Namespace name cannot be empty');
        }

        // PostgreSQL identifiers: alphanumeric + underscore only
        // This prevents SQL injection via namespace names
        if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
            throw new Error(`Namespace name "${nsName}" contains invalid characters`);
        }

        // PostgreSQL max identifier length is 63 bytes
        if (trimmed.length > 63) {
            throw new Error(`Namespace name "${nsName}" exceeds PostgreSQL limit (63 chars)`);
        }
    }
}
