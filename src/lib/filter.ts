import { FilterWhere } from '@src/lib/filter-where.js';
import { FilterOrder } from '@src/lib/filter-order.js';
import { FilterSqlGenerator, type FilterState } from '@src/lib/filter-sql-generator.js';
import { FilterOp, type FilterWhereInfo, type FilterWhereOptions, type FilterData, type ConditionNode, type FilterOrderInfo, type AggregateSpec, type AggregateFunction } from '@src/lib/filter-types.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

// Re-export types for convenience
export type { FilterData, FilterOp, FilterWhereInfo, FilterWhereOptions, FilterOrderInfo, ConditionNode, AggregateSpec, AggregateFunction } from '@src/lib/filter-types.js';
export type { FilterState } from '@src/lib/filter-sql-generator.js';

/**
 * Filter - Enterprise-Grade Database Query Builder
 *
 * Comprehensive query builder with 25+ operators including PostgreSQL arrays, logical operations,
 * full-text search, and advanced filtering patterns. Integrates with observer pipeline and ACL systems.
 *
 * Provides clean separation of concerns:
 * - Filter data validation and normalization
 * - SQL generation with proper parameterization
 * - Query execution via consistent API patterns
 *
 * Quick Examples:
 * - Basic: `{ name: { $ilike: "john%" }, status: "active" }`
 * - ACL: `{ access_read: { $any: ["user-123", "group-456"] } }`
 * - Logic: `{ $and: [{ $or: [{ access: "root" }, { verified: true }] }] }`
 *
 * Architecture: Filter → FilterWhere → FilterOrder → SQL generation
 * Integration: Observer pipeline, soft delete filtering, model validation
 *
 * See docs/FILTER.md for complete operator reference and examples.
 */

// All types and enums are now imported from filter-types.js for consistency

/**
 * Filter - Handles database query building with proper validation and execution
 *
 * Provides clean separation of concerns:
 * - Filter data validation and normalization
 * - SQL generation with proper parameterization
 * - Query execution via consistent API patterns
 *
 * Designed for integration with observer pipeline and ACL systems.
 */
export class Filter {
    private _tableName: string;
    private _query: any;
    private _select: string[] = [];
    private _whereData: any = {}; // Store raw WHERE data for FilterWhere
    private _order: FilterOrderInfo[] = [];
    private _limit?: number;
    private _offset?: number;
    private _lookups: any[] = [];
    private _related: any[] = [];
    private _trashedOption: FilterWhereOptions = {};
    private _accessUserIds: string[] = [];

    constructor(tableName: string) {
        this._tableName = tableName;
        this.validateTableName(tableName);

        // For dynamic models, we'll build queries using raw SQL
        // since Drizzle's type system doesn't know about runtime tables
        this._query = null; // Will build SQL manually
    }

    // Parameter management is now handled by FilterWhere

    /**
     * Process filter data with comprehensive validation and normalization
     */
    assign(source?: FilterData | string | string[]): Filter {
        if (source === undefined) {
            return this;
        }

        try {
            // Validate and normalize input
            const normalizedSource = this.validateAndNormalizeInput(source);

            // Process the normalized data
            this.processFilterData(normalizedSource);

            console.debug('Filter assignment completed', {
                tableName: this._tableName,
                sourceType: Array.isArray(source) ? 'array' : typeof source
            });

        } catch (error) {
            console.warn('Filter assignment failed', {
                tableName: this._tableName,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error; // Re-throw to maintain error handling
        }

        return this;
    }

    /**
     * Validate table name to prevent SQL injection
     */
    private validateTableName(tableName: string): void {
        if (!tableName || typeof tableName !== 'string') {
            throw HttpErrors.badRequest('Table name must be a non-empty string', 'FILTER_INVALID_TABLE');
        }

        // Basic SQL injection protection for table names
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
            throw HttpErrors.badRequest('Invalid table name format', 'FILTER_INVALID_TABLE_FORMAT');
        }
    }

    /**
     * Validate and normalize filter input data
     */
    private validateAndNormalizeInput(source: FilterData | string | string[]): FilterData {
        // Array of IDs → convert to $in (skip empty arrays)
        if (Array.isArray(source)) {
            if (source.length === 0) {
                return {}; // Empty array = no conditions
            }
            return { where: { id: { $in: source } } };
        }

        // Single UUID → convert to $eq
        if (typeof source === 'string' && this.isUUID(source)) {
            return { where: { id: source } };
        }

        // Plain string → assume name field
        if (typeof source === 'string') {
            return { where: { name: source } };
        }

        // Process FilterData object
        if (typeof source === 'object' && source !== null) {
            return this.validateFilterData(source);
        }

        throw HttpErrors.badRequest('Invalid filter source type', 'FILTER_INVALID_SOURCE_TYPE');
    }

    /**
     * Validate FilterData object structure
     */
    private validateFilterData(source: FilterData): FilterData {
        // Validate select array if provided
        if (source.select && (!Array.isArray(source.select) || source.select.some(col => typeof col !== 'string'))) {
            throw HttpErrors.badRequest('Select must be an array of field names', 'FILTER_INVALID_SELECT');
        }

        // Validate limit/offset if provided
        if (source.limit !== undefined && (!Number.isInteger(source.limit) || source.limit < 0)) {
            throw HttpErrors.badRequest('Limit must be a non-negative integer', 'FILTER_INVALID_LIMIT');
        }

        if (source.offset !== undefined && (!Number.isInteger(source.offset) || source.offset < 0)) {
            throw HttpErrors.badRequest('Offset must be a non-negative integer', 'FILTER_INVALID_OFFSET');
        }

        return source;
    }

    /**
     * Process validated FilterData with proper error handling
     */
    private processFilterData(source: FilterData): void {
        try {
            // SELECT
            if (source.select) {
                this.processSelectClause(source.select);
            }

            // WHERE
            if (source.where) {
                this.processWhereClause(source.where);
            }

            // ORDER
            if (source.order) {
                this.processOrderClause(source.order);
            }

            // LIMIT/OFFSET
            if (source.limit !== undefined) {
                this.processLimitClause(source.limit, source.offset);
            }

            // TODO: LOOKUPS and RELATED
            // if (source.lookups) this.processLookups(source.lookups);
            // if (source.related) this.processRelated(source.related);

        } catch (error) {
            throw error; // Re-throw validation errors
        }
    }

    /**
     * Process SELECT clause with validation
     */
    private processSelectClause(fields: string[]): void {
        this.validateSelectFields(fields);
        this.$select(...fields);
    }

    /**
     * Validate SELECT fields
     */
    private validateSelectFields(fields: string[]): void {
        if (!Array.isArray(fields)) {
            throw HttpErrors.badRequest('Select fields must be an array', 'FILTER_INVALID_SELECT_TYPE');
        }

        for (const field of fields) {
            if (typeof field !== 'string' || !field.trim()) {
                throw HttpErrors.badRequest('All select fields must be non-empty strings', 'FILTER_INVALID_FIELD_NAME');
            }

            // Basic SQL injection protection for field names
            if (field !== '*' && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
                throw HttpErrors.badRequest(`Invalid field name format: ${field}`, 'FILTER_INVALID_FIELD_FORMAT');
            }
        }
    }

    /**
     * SELECT field specification
     */
    $select(...fields: string[]): Filter {
        // If '*' is included, select all (for now, just track the request)
        if (fields.includes('*')) {
            this._select = ['*'];
        } else {
            this._select.push(...fields);
        }
        return this;
    }

    /**
     * Process WHERE clause with validation - delegates to FilterWhere
     */
    private processWhereClause(conditions: any): void {
        // Let FilterWhere handle all validation
        FilterWhere.validate(conditions);
        this.$where(conditions);
    }

    /**
     * WHERE clause processing - simplified to delegate to FilterWhere
     */
    $where(conditions: any): Filter {
        if (!conditions) return this;

        // Store raw WHERE data for FilterWhere to process
        if (this._whereData && Object.keys(this._whereData).length > 0) {
            // Merge with existing conditions using $and
            this._whereData = {
                $and: [this._whereData, conditions]
            };
        } else {
            this._whereData = conditions;
        }

        return this;
    }

    /**
     * Process ORDER clause with validation - delegates to FilterOrder
     */
    private processOrderClause(orderSpec: any): void {
        // Let FilterOrder handle all validation
        FilterOrder.validate(orderSpec);
        this.$order(orderSpec);
    }

    /**
     * ORDER BY processing - simplified to store raw data for FilterOrder
     */
    $order(orderSpec: any): Filter {
        if (!orderSpec) return this;

        // Store raw ORDER data for FilterOrder to process
        // Convert to array format for consistent handling
        if (Array.isArray(orderSpec)) {
            this._order.push(...this.normalizeOrderSpecToArray(orderSpec));
        } else {
            this._order.push(...this.normalizeOrderSpecToArray([orderSpec]));
        }

        return this;
    }

    /**
     * Normalize order specification to FilterOrderInfo array
     */
    private normalizeOrderSpecToArray(orderSpecs: any[]): FilterOrderInfo[] {
        const result: FilterOrderInfo[] = [];

        for (const spec of orderSpecs) {
            if (typeof spec === 'string') {
                const parts = spec.split(' ');
                const field = parts[0];
                const sort = (parts[1] || 'asc').toLowerCase() as 'asc' | 'desc';
                result.push({ field, sort: sort === 'desc' ? 'desc' : 'asc' });
            } else if (typeof spec === 'object' && spec !== null) {
                if (spec.field && spec.sort) {
                    const sort = spec.sort.toLowerCase();
                    result.push({
                        field: spec.field,
                        sort: (sort === 'desc' || sort === 'descending') ? 'desc' : 'asc'
                    });
                } else {
                    // Process all entries in the object: { name: 'asc', created_at: 'desc' }
                    for (const [field, sort] of Object.entries(spec)) {
                        const normalizedSort = (sort as string).toLowerCase();
                        result.push({
                            field,
                            sort: (normalizedSort === 'desc' || normalizedSort === 'descending') ? 'desc' : 'asc'
                        });
                    }
                }
            }
        }

        return result;
    }

    /**
     * Process LIMIT clause with validation
     */
    private processLimitClause(limit: number, offset?: number): void {
        this.validateLimitClause(limit, offset);
        this.$limit(limit, offset);
    }

    /**
     * Validate LIMIT/OFFSET clause
     */
    private validateLimitClause(limit: number, offset?: number): void {
        if (!Number.isInteger(limit) || limit < 0) {
            throw HttpErrors.badRequest('Limit must be a non-negative integer', 'FILTER_INVALID_LIMIT_VALUE');
        }

        if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
            throw HttpErrors.badRequest('Offset must be a non-negative integer', 'FILTER_INVALID_OFFSET_VALUE');
        }
    }

    /**
     * LIMIT/OFFSET processing
     */
    $limit(limit?: number, offset?: number): Filter {
        this._limit = limit;
        this._offset = offset;
        return this;
    }

    /**
     * Configure trashed record visibility
     * @param options - trashed: 'exclude' | 'include' | 'only', adapterType: 'postgresql' | 'sqlite'
     */
    withTrashed(options: FilterWhereOptions): Filter {
        this._trashedOption = options;
        return this;
    }

    /**
     * Configure ACL filtering based on user IDs
     * Records are visible if any of the provided user IDs appear in
     * access_read, access_edit, or access_full arrays (and none in access_deny).
     * @param userIds - Array of user/group IDs from SystemContext.getUser()
     * @param isSudo - If true, ACL filtering is skipped entirely (sudo users see all records)
     */
    withAccess(userIds: string[], isSudo: boolean = false): Filter {
        // Sudo users bypass ACL filtering entirely
        this._accessUserIds = isSudo ? [] : userIds;
        return this;
    }

    /**
     * Get current filter state for SQL generation
     */
    private getFilterState(): FilterState {
        return {
            tableName: this._tableName,
            select: this._select,
            whereData: this._whereData,
            order: this._order,
            limit: this._limit,
            offset: this._offset,
            trashedOption: this._trashedOption,
            accessUserIds: this._accessUserIds
        };
    }

    /**
     * Generate SQL query and parameters with comprehensive validation
     *
     * Returns SQL query and parameters for execution by Database methods.
     * Uses FilterSqlGenerator for consistent SQL generation with soft delete support.
     */
    toSQL(): { query: string; params: any[] } {
        return FilterSqlGenerator.toSQL(this.getFilterState());
    }

    /**
     * Generate WHERE clause with parameters for use in custom queries
     *
     * Returns WHERE clause conditions and parameters that can be used
     * to build COUNT queries or other custom SQL statements.
     */
    toWhereSQL(): { whereClause: string; params: any[] } {
        return FilterSqlGenerator.toWhereSQL(this.getFilterState());
    }

    /**
     * Generate COUNT query with parameters
     *
     * Returns a COUNT(*) query using the current filter conditions.
     * Useful for pagination and result count operations.
     */
    toCountSQL(): { query: string; params: any[] } {
        return FilterSqlGenerator.toCountSQL(this.getFilterState());
    }

    /**
     * Generate aggregation query with parameters
     *
     * Returns an aggregation query (SUM, AVG, MIN, MAX, COUNT) with optional GROUP BY.
     * Useful for analytics, dashboards, and statistical queries.
     */
    toAggregateSQL(aggregations: AggregateSpec, groupBy?: string[]): { query: string; params: any[] } {
        return FilterSqlGenerator.toAggregateSQL(this.getFilterState(), aggregations, groupBy);
    }

    /**
     * Get just the WHERE clause conditions for use in other queries
     */
    getWhereClause(): string {
        return FilterSqlGenerator.getWhereClause(this.getFilterState());
    }

    /**
     * Get just the ORDER BY clause for use in other queries
     */
    getOrderClause(): string {
        return FilterSqlGenerator.getOrderClause(this.getFilterState());
    }

    /**
     * Get just the LIMIT/OFFSET clause for use in other queries
     */
    getLimitClause(): string {
        return FilterSqlGenerator.getLimitClause(this.getFilterState());
    }



    /**
     * Utility method to check if string is a valid UUID
     */
    private isUUID(str: string): boolean {
        if (typeof str !== 'string') {
            return false;
        }

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidRegex.test(str);
    }

    // TODO: Implement advanced features
    // $lookups(config: any): Filter { }
    // $related(config: any): Filter { }
    // $join(config: any): Filter { }
}
