/**
 * Filter - Query builder with SQL generation for SQLite
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Filter class provides a fluent query builder that generates parameterized
 * SQL for SQLite. It supports 26 operators including comparisons, pattern
 * matching, array membership, and logical combinations.
 *
 * TODO: PostgreSQL-only operators not yet implemented:
 * - $any   : Array overlap (field && ARRAY[...])
 * - $all   : Array contains all (field @> ARRAY[...])
 * - $nany  : NOT array overlap
 * - $nall  : NOT array contains all
 * - $search: Full-text search (to_tsvector @@ plainto_tsquery)
 * These require PostgreSQL-specific syntax and have no direct SQLite equivalent.
 *
 * AVAILABLE OPERATORS
 * ===================
 *
 * Comparison Operators:
 * ┌──────────┬─────────────────────┬─────────────────────────────────────────┐
 * │ Operator │ SQL Generated       │ Example                                 │
 * ├──────────┼─────────────────────┼─────────────────────────────────────────┤
 * │ $eq      │ field = ?           │ { status: 'active' }                    │
 * │          │ field IS NULL       │ { status: { $eq: null } }               │
 * │ $ne      │ field != ?          │ { status: { $ne: 'deleted' } }          │
 * │ $neq     │ (alias for $ne)     │ { status: { $neq: 'deleted' } }         │
 * │ $gt      │ field > ?           │ { age: { $gt: 18 } }                    │
 * │ $gte     │ field >= ?          │ { age: { $gte: 18 } }                   │
 * │ $lt      │ field < ?           │ { age: { $lt: 65 } }                    │
 * │ $lte     │ field <= ?          │ { age: { $lte: 65 } }                   │
 * └──────────┴─────────────────────┴─────────────────────────────────────────┘
 *
 * Pattern Matching Operators:
 * ┌──────────┬─────────────────────────────┬─────────────────────────────────┐
 * │ Operator │ SQL Generated               │ Example                         │
 * ├──────────┼─────────────────────────────┼─────────────────────────────────┤
 * │ $like    │ field LIKE ?                │ { name: { $like: 'John%' } }    │
 * │ $ilike   │ LOWER(field) LIKE LOWER(?)  │ { name: { $ilike: 'john%' } }   │
 * │ $nlike   │ field NOT LIKE ?            │ { name: { $nlike: '%test%' } }  │
 * │ $nilike  │ LOWER(field) NOT LIKE ...   │ { name: { $nilike: '%TEST%' } } │
 * │ $regex   │ field REGEXP ?              │ { name: { $regex: '^test' } }   │
 * │ $nregex  │ field NOT REGEXP ?          │ { name: { $nregex: '^test' } }  │
 * └──────────┴─────────────────────────────┴─────────────────────────────────┘
 *
 * Text Search Operators:
 * ┌──────────┬─────────────────────────────┬─────────────────────────────────┐
 * │ Operator │ SQL Generated               │ Example                         │
 * ├──────────┼─────────────────────────────┼─────────────────────────────────┤
 * │ $find    │ LOWER(field) LIKE ?         │ { desc: { $find: 'foo' } }      │
 * │ $text    │ (alias for $find)           │ { desc: { $text: 'foo' } }      │
 * └──────────┴─────────────────────────────┴─────────────────────────────────┘
 * Note: $find/$text wrap value with %...% for contains matching.
 *
 * Array Membership Operators:
 * ┌──────────┬─────────────────────────────┬─────────────────────────────────┐
 * │ Operator │ SQL Generated               │ Example                         │
 * ├──────────┼─────────────────────────────┼─────────────────────────────────┤
 * │ $in      │ field IN (?, ?, ...)        │ { status: { $in: ['a', 'b'] } } │
 * │          │ 0=1 (empty array)           │ { status: { $in: [] } }         │
 * │ $nin     │ field NOT IN (?, ?, ...)    │ { status: { $nin: ['x'] } }     │
 * │          │ 1=1 (empty array)           │ { status: { $nin: [] } }        │
 * └──────────┴─────────────────────────────┴─────────────────────────────────┘
 *
 * JSON Array Operators:
 * ┌──────────┬─────────────────────────────┬─────────────────────────────────┐
 * │ Operator │ SQL Generated               │ Example                         │
 * ├──────────┼─────────────────────────────┼─────────────────────────────────┤
 * │ $size    │ json_array_length(field)    │ { tags: { $size: 3 } }          │
 * │          │ (supports nested operators) │ { tags: { $size: { $gte: 1 } }} │
 * └──────────┴─────────────────────────────┴─────────────────────────────────┘
 *
 * Logical Operators:
 * ┌──────────┬─────────────────────────────┬─────────────────────────────────┐
 * │ Operator │ SQL Generated               │ Example                         │
 * ├──────────┼─────────────────────────────┼─────────────────────────────────┤
 * │ $and     │ (... AND ...)               │ { $and: [{ a: 1 }, { b: 2 }] }  │
 * │ $or      │ (... OR ...)                │ { $or: [{ a: 1 }, { b: 2 }] }   │
 * │ $not     │ NOT (...)                   │ { $not: { status: 'deleted' } } │
 * │ $nand    │ NOT (... AND ...)           │ { $nand: [{ a: 1 }, { b: 2 }] } │
 * │ $nor     │ NOT (... OR ...)            │ { $nor: [{ a: 1 }, { b: 2 }] }  │
 * └──────────┴─────────────────────────────┴─────────────────────────────────┘
 *
 * Range Operator:
 * ┌──────────┬─────────────────────────────┬─────────────────────────────────┐
 * │ Operator │ SQL Generated               │ Example                         │
 * ├──────────┼─────────────────────────────┼─────────────────────────────────┤
 * │ $between │ field BETWEEN ? AND ?       │ { age: { $between: [18, 65] } } │
 * └──────────┴─────────────────────────────┴─────────────────────────────────┘
 *
 * Null/Existence Operators:
 * ┌──────────┬─────────────────────────────┬─────────────────────────────────┐
 * │ Operator │ SQL Generated               │ Example                         │
 * ├──────────┼─────────────────────────────┼─────────────────────────────────┤
 * │ $exists  │ field IS NOT NULL (true)    │ { email: { $exists: true } }    │
 * │          │ field IS NULL (false)       │ { email: { $exists: false } }   │
 * │ $null    │ field IS NULL (true)        │ { deleted: { $null: true } }    │
 * │          │ field IS NOT NULL (false)   │ { deleted: { $null: false } }   │
 * └──────────┴─────────────────────────────┴─────────────────────────────────┘
 *
 * USAGE
 * =====
 * ```typescript
 * // Simple filter
 * const filter = new Filter('file')
 *     .where({ status: 'active', owner: 'user-123' })
 *     .order([{ field: 'name', sort: 'asc' }])
 *     .limit(10);
 *
 * const { sql, params } = filter.toSQL();
 * // SELECT * FROM file WHERE status = ? AND owner = ? ORDER BY name ASC LIMIT 10
 * // params: ['active', 'user-123']
 *
 * // Complex filter with operators
 * const filter = new Filter('file')
 *     .where({
 *         $or: [
 *             { owner: 'user-123' },
 *             { size: { $gte: 1000 } }
 *         ]
 *     });
 * ```
 *
 * SECURITY
 * ========
 * - Table and field names are validated against SQL injection patterns
 * - All values are parameterized (never interpolated into SQL)
 * - Operators are whitelisted via FilterOp enum
 *
 * INVARIANTS
 * ==========
 * INV-1: params array index matches ? placeholder order in generated SQL
 * INV-2: All field/table names validated before SQL generation
 * INV-3: Internal state (whereData, orderSpecs) only modified via public methods
 * INV-4: toSQL() is idempotent - calling multiple times yields same result
 * INV-5: Empty $in/$nin arrays generate FALSE/TRUE conditions (never invalid SQL)
 *
 * CONCURRENCY MODEL
 * =================
 * Filter is a pure synchronous class with no external dependencies:
 * - No async operations
 * - No shared mutable state between instances
 * - Safe for concurrent use from multiple async contexts
 * - Each instance maintains its own internal state
 *
 * Filters are typically created per-request and discarded after use.
 * They should not be shared across requests or stored long-term.
 *
 * @module model/filter
 */

import {
    FilterOp,
    type FilterData,
    type WhereConditions,
    type OrderSpec,
    type SelectOptions,
    type SqlResult,
    type WhereResult,
    type TrashedOption,
} from './filter-types.js';
import { EINVAL } from '@src/hal/errors.js';

// =============================================================================
// FILTER CLASS
// =============================================================================

/**
 * Query builder with SQL generation for SQLite.
 *
 * TESTABILITY: Pure class with no external dependencies.
 * All SQL generation is deterministic and testable.
 */
export class Filter {
    // =========================================================================
    // STATE
    // =========================================================================

    private readonly tableName: string;
    private selectFields: string[] = ['*'];
    private whereData: WhereConditions = {};
    private orderSpecs: OrderSpec[] = [];
    private limitValue?: number;
    private offsetValue?: number;
    private trashedOption: TrashedOption = 'exclude';

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new Filter for a table.
     *
     * @param tableName - Table name (validated for SQL injection)
     */
    constructor(tableName: string) {
        this.validateIdentifier(tableName, 'table name');
        this.tableName = tableName;
    }

    // =========================================================================
    // FLUENT BUILDERS
    // =========================================================================

    /**
     * Set SELECT fields.
     *
     * @param fields - Field names or '*' for all
     */
    select(...fields: string[]): Filter {
        if (fields.length === 0 || fields.includes('*')) {
            this.selectFields = ['*'];
        } else {
            for (const field of fields) {
                this.validateIdentifier(field, 'field name');
            }
            this.selectFields = fields;
        }
        return this;
    }

    /**
     * Set WHERE conditions.
     *
     * @param conditions - Where conditions object
     */
    where(conditions: WhereConditions): Filter {
        this.whereData = conditions;
        return this;
    }

    /**
     * Add WHERE conditions (merged with existing via $and).
     *
     * @param conditions - Additional where conditions
     */
    andWhere(conditions: WhereConditions): Filter {
        if (Object.keys(this.whereData).length === 0) {
            this.whereData = conditions;
        } else {
            this.whereData = {
                $and: [this.whereData, conditions],
            };
        }
        return this;
    }

    /**
     * Set ORDER BY clauses.
     *
     * @param specs - Order specifications
     */
    order(specs: OrderSpec | OrderSpec[] | string | string[]): Filter {
        this.orderSpecs = this.normalizeOrder(specs);
        return this;
    }

    /**
     * Set LIMIT.
     *
     * @param value - Maximum records to return
     */
    limit(value: number): Filter {
        this.limitValue = value;
        return this;
    }

    /**
     * Set OFFSET.
     *
     * @param value - Records to skip
     */
    offset(value: number): Filter {
        this.offsetValue = value;
        return this;
    }

    /**
     * Set soft-delete filtering.
     *
     * @param option - 'exclude' (default), 'include', or 'only'
     */
    trashed(option: TrashedOption): Filter {
        this.trashedOption = option;
        return this;
    }

    /**
     * Apply FilterData object.
     *
     * @param data - Complete filter specification
     * @param options - Select options (trashed handling)
     */
    apply(data: FilterData = {}, options: SelectOptions = {}): Filter {
        if (data.select) {
            this.select(...data.select);
        }
        if (data.where) {
            this.where(data.where);
        }
        if (data.order) {
            this.order(data.order);
        }
        if (data.limit !== undefined) {
            this.limit(data.limit);
        }
        if (data.offset !== undefined) {
            this.offset(data.offset);
        }
        if (options.trashed) {
            this.trashed(options.trashed);
        }
        return this;
    }

    // =========================================================================
    // SQL GENERATION
    // =========================================================================

    /**
     * Generate complete SELECT query.
     *
     * @returns SQL and parameters
     */
    toSQL(): SqlResult {
        const parts: string[] = [];
        const params: unknown[] = [];

        // SELECT
        parts.push(`SELECT ${this.selectFields.join(', ')} FROM ${this.tableName}`);

        // WHERE
        const where = this.buildWhereClause(params);
        if (where) {
            parts.push(`WHERE ${where}`);
        }

        // ORDER BY
        if (this.orderSpecs.length > 0) {
            const orderClauses = this.orderSpecs.map(
                (s) => `${s.field} ${s.sort.toUpperCase()}`
            );
            parts.push(`ORDER BY ${orderClauses.join(', ')}`);
        }

        // LIMIT/OFFSET
        if (this.limitValue !== undefined) {
            parts.push(`LIMIT ${this.limitValue}`);
        }
        if (this.offsetValue !== undefined) {
            parts.push(`OFFSET ${this.offsetValue}`);
        }

        return { sql: parts.join(' '), params };
    }

    /**
     * Generate COUNT query.
     *
     * @returns SQL and parameters for count
     */
    toCountSQL(): SqlResult {
        const params: unknown[] = [];
        const parts: string[] = [`SELECT COUNT(*) as count FROM ${this.tableName}`];

        const where = this.buildWhereClause(params);
        if (where) {
            parts.push(`WHERE ${where}`);
        }

        return { sql: parts.join(' '), params };
    }

    /**
     * Generate WHERE clause only.
     *
     * @returns Clause and parameters
     */
    toWhereSQL(): WhereResult {
        const params: unknown[] = [];
        const clause = this.buildWhereClause(params);
        return { clause: clause || '1=1', params };
    }

    // =========================================================================
    // PRIVATE - WHERE CLAUSE BUILDING
    // =========================================================================

    /**
     * Build complete WHERE clause including soft-delete handling.
     */
    private buildWhereClause(params: unknown[]): string {
        const conditions: string[] = [];

        // Add soft-delete condition
        const trashedCondition = this.buildTrashedCondition();
        if (trashedCondition) {
            conditions.push(trashedCondition);
        }

        // Add user conditions
        const userCondition = this.buildConditions(this.whereData, params);
        if (userCondition) {
            conditions.push(userCondition);
        }

        return conditions.length > 0 ? conditions.join(' AND ') : '';
    }

    /**
     * Build soft-delete condition.
     */
    private buildTrashedCondition(): string {
        switch (this.trashedOption) {
            case 'exclude':
                return 'trashed_at IS NULL';
            case 'only':
                return 'trashed_at IS NOT NULL';
            case 'include':
            default:
                return '';
        }
    }

    /**
     * Build conditions from WhereConditions object.
     */
    private buildConditions(conditions: WhereConditions, params: unknown[]): string {
        if (!conditions || Object.keys(conditions).length === 0) {
            return '';
        }

        const parts: string[] = [];

        for (const [key, value] of Object.entries(conditions)) {
            if (value === undefined) continue;

            // Handle logical operators
            if (key === '$and' || key === FilterOp.AND) {
                const subConditions = value as WhereConditions[];
                const subParts = subConditions
                    .map((c) => this.buildConditions(c, params))
                    .filter(Boolean);
                if (subParts.length > 0) {
                    parts.push(`(${subParts.join(' AND ')})`);
                }
                continue;
            }

            if (key === '$or' || key === FilterOp.OR) {
                const subConditions = value as WhereConditions[];
                const subParts = subConditions
                    .map((c) => this.buildConditions(c, params))
                    .filter(Boolean);
                if (subParts.length > 0) {
                    parts.push(`(${subParts.join(' OR ')})`);
                }
                continue;
            }

            if (key === '$not' || key === FilterOp.NOT) {
                const subCondition = this.buildConditions(value as WhereConditions, params);
                if (subCondition) {
                    parts.push(`NOT (${subCondition})`);
                }
                continue;
            }

            if (key === '$nand' || key === FilterOp.NAND) {
                const subConditions = value as WhereConditions[];
                const subParts = subConditions
                    .map((c) => this.buildConditions(c, params))
                    .filter(Boolean);
                if (subParts.length > 0) {
                    parts.push(`NOT (${subParts.join(' AND ')})`);
                }
                continue;
            }

            if (key === '$nor' || key === FilterOp.NOR) {
                const subConditions = value as WhereConditions[];
                const subParts = subConditions
                    .map((c) => this.buildConditions(c, params))
                    .filter(Boolean);
                if (subParts.length > 0) {
                    parts.push(`NOT (${subParts.join(' OR ')})`);
                }
                continue;
            }

            // Regular field condition
            this.validateIdentifier(key, 'field name');
            const condition = this.buildFieldCondition(key, value, params);
            if (condition) {
                parts.push(condition);
            }
        }

        return parts.join(' AND ');
    }

    /**
     * Build condition for a single field.
     */
    private buildFieldCondition(
        field: string,
        value: unknown,
        params: unknown[]
    ): string {
        // Null value
        if (value === null) {
            return `${field} IS NULL`;
        }

        // Primitive value (implicit $eq)
        if (typeof value !== 'object') {
            params.push(value);
            return `${field} = ?`;
        }

        // Operator object
        const operators = value as Record<string, unknown>;
        const conditions: string[] = [];

        for (const [op, opValue] of Object.entries(operators)) {
            const condition = this.buildOperatorCondition(field, op, opValue, params);
            if (condition) {
                conditions.push(condition);
            }
        }

        return conditions.join(' AND ');
    }

    /**
     * Build condition for a specific operator.
     */
    private buildOperatorCondition(
        field: string,
        op: string,
        value: unknown,
        params: unknown[]
    ): string {
        switch (op) {
            // Comparison
            case '$eq':
            case FilterOp.EQ:
                if (value === null) return `${field} IS NULL`;
                params.push(value);
                return `${field} = ?`;

            case '$ne':
            case FilterOp.NE:
            case '$neq':
            case FilterOp.NEQ:
                if (value === null) return `${field} IS NOT NULL`;
                params.push(value);
                return `${field} != ?`;

            case '$gt':
            case FilterOp.GT:
                params.push(value);
                return `${field} > ?`;

            case '$gte':
            case FilterOp.GTE:
                params.push(value);
                return `${field} >= ?`;

            case '$lt':
            case FilterOp.LT:
                params.push(value);
                return `${field} < ?`;

            case '$lte':
            case FilterOp.LTE:
                params.push(value);
                return `${field} <= ?`;

            // Pattern matching
            case '$like':
            case FilterOp.LIKE:
                params.push(value);
                return `${field} LIKE ?`;

            case '$ilike':
            case FilterOp.ILIKE:
                // SQLite: use LOWER() for case-insensitive
                params.push(String(value).toLowerCase());
                return `LOWER(${field}) LIKE LOWER(?)`;

            case '$nlike':
            case FilterOp.NLIKE:
                params.push(value);
                return `${field} NOT LIKE ?`;

            case '$nilike':
            case FilterOp.NILIKE:
                params.push(String(value).toLowerCase());
                return `LOWER(${field}) NOT LIKE LOWER(?)`;

            // Regex matching (requires regexp function registered in SQLite)
            case '$regex':
            case FilterOp.REGEX:
                params.push(value);
                return `${field} REGEXP ?`;

            case '$nregex':
            case FilterOp.NREGEX:
                params.push(value);
                return `${field} NOT REGEXP ?`;

            // Text search (case-insensitive contains)
            case '$find':
            case FilterOp.FIND:
            case '$text':
            case FilterOp.TEXT:
                params.push(`%${String(value).toLowerCase()}%`);
                return `LOWER(${field}) LIKE ?`;

            // Array membership
            case '$in':
            case FilterOp.IN: {
                const arr = value as unknown[];
                if (arr.length === 0) return '0=1'; // Empty IN = no match
                const placeholders = arr.map(() => '?').join(', ');
                params.push(...arr);
                return `${field} IN (${placeholders})`;
            }

            case '$nin':
            case FilterOp.NIN: {
                const arr = value as unknown[];
                if (arr.length === 0) return '1=1'; // Empty NIN = all match
                const placeholders = arr.map(() => '?').join(', ');
                params.push(...arr);
                return `${field} NOT IN (${placeholders})`;
            }

            // JSON array size (SQLite uses json_array_length)
            case '$size':
            case FilterOp.SIZE: {
                const lengthExpr = `json_array_length(${field})`;
                if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                    // Nested operator: { $size: { $gte: 1 } }
                    const entries = Object.entries(value as Record<string, unknown>);
                    if (entries.length === 1) {
                        const [nestedOp, nestedValue] = entries[0]!;
                        return this.buildSizeCondition(lengthExpr, nestedOp, nestedValue, params);
                    }
                }
                // Simple equality: { $size: 3 }
                params.push(value);
                return `${lengthExpr} = ?`;
            }

            // Range
            case '$between':
            case FilterOp.BETWEEN: {
                const [min, max] = value as [unknown, unknown];
                params.push(min, max);
                return `${field} BETWEEN ? AND ?`;
            }

            // Null/existence
            case '$exists':
            case FilterOp.EXISTS:
                return value ? `${field} IS NOT NULL` : `${field} IS NULL`;

            case '$null':
            case FilterOp.NULL:
                return value ? `${field} IS NULL` : `${field} IS NOT NULL`;

            default:
                throw new EINVAL(`Unknown filter operator: ${op}`);
        }
    }

    /**
     * Build condition for $size with nested operator.
     */
    private buildSizeCondition(
        lengthExpr: string,
        op: string,
        value: unknown,
        params: unknown[]
    ): string {
        switch (op) {
            case '$eq':
            case FilterOp.EQ:
                params.push(value);
                return `${lengthExpr} = ?`;
            case '$ne':
            case FilterOp.NE:
            case '$neq':
            case FilterOp.NEQ:
                params.push(value);
                return `${lengthExpr} != ?`;
            case '$gt':
            case FilterOp.GT:
                params.push(value);
                return `${lengthExpr} > ?`;
            case '$gte':
            case FilterOp.GTE:
                params.push(value);
                return `${lengthExpr} >= ?`;
            case '$lt':
            case FilterOp.LT:
                params.push(value);
                return `${lengthExpr} < ?`;
            case '$lte':
            case FilterOp.LTE:
                params.push(value);
                return `${lengthExpr} <= ?`;
            default:
                throw new EINVAL(`Unsupported operator for $size: ${op}`);
        }
    }

    // =========================================================================
    // PRIVATE - HELPERS
    // =========================================================================

    /**
     * Validate identifier (table/field name) for SQL injection.
     */
    private validateIdentifier(name: string, context: string): void {
        if (!name || typeof name !== 'string') {
            throw new EINVAL(`Invalid ${context}: must be a non-empty string`);
        }

        // Allow only alphanumeric, underscore, and dot (for qualified names)
        if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(name)) {
            throw new EINVAL(`Invalid ${context} format: ${name}`);
        }
    }

    /**
     * Normalize order specification to OrderSpec array.
     */
    private normalizeOrder(
        specs: OrderSpec | OrderSpec[] | string | string[]
    ): OrderSpec[] {
        const result: OrderSpec[] = [];

        const specArray = Array.isArray(specs) ? specs : [specs];

        for (const spec of specArray) {
            if (typeof spec === 'string') {
                // Parse "field" or "field asc" or "field desc"
                const parts = spec.trim().split(/\s+/);
                const field = parts[0] ?? '';
                if (!field) continue; // Skip empty strings
                const sort = (parts[1]?.toLowerCase() === 'desc' ? 'desc' : 'asc') as
                    | 'asc'
                    | 'desc';
                this.validateIdentifier(field, 'order field');
                result.push({ field, sort });
            } else {
                this.validateIdentifier(spec.field, 'order field');
                result.push({
                    field: spec.field,
                    sort: spec.sort.toLowerCase() === 'desc' ? 'desc' : 'asc',
                });
            }
        }

        return result;
    }

    // =========================================================================
    // STATIC FACTORY
    // =========================================================================

    /**
     * Create a Filter from FilterData.
     *
     * @param tableName - Table to query
     * @param data - Filter data
     * @param options - Select options
     */
    static from(
        tableName: string,
        data: FilterData = {},
        options: SelectOptions = {}
    ): Filter {
        return new Filter(tableName).apply(data, options);
    }
}
