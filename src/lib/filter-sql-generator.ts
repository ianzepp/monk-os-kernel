import { FilterWhere } from '@src/lib/filter-where.js';
import { FilterWhereSqlite } from '@src/lib/filter-where-sqlite.js';
import { FilterOrder } from '@src/lib/filter-order.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import type { FilterWhereOptions, FilterOrderInfo, AggregateSpec } from '@src/lib/filter-types.js';

/**
 * Filter state required for SQL generation
 */
export interface FilterState {
    tableName: string;
    select: string[];
    whereData: any;
    order: FilterOrderInfo[];
    limit?: number;
    offset?: number;
    trashedOption: FilterWhereOptions;
    accessUserIds: string[];
}

/**
 * FilterSqlGenerator - SQL Query Generation for Filter
 *
 * Handles all SQL generation logic for Filter class including:
 * - SELECT queries with WHERE, ORDER BY, LIMIT/OFFSET
 * - WHERE clause extraction for custom queries
 * - COUNT queries for pagination
 * - Aggregation queries (SUM, AVG, MIN, MAX, COUNT, DISTINCT)
 *
 * Design: Pure functions that take FilterState and return SQL + parameters.
 * This separation allows for easier testing and clearer separation of concerns.
 */
export class FilterSqlGenerator {
    /**
     * Generate complete SQL query with parameters
     *
     * Returns SELECT query with WHERE, ORDER BY, and LIMIT/OFFSET clauses.
     */
    static toSQL(state: FilterState): { query: string; params: any[] } {
        try {
            // Build SELECT clause (no parameters)
            const selectClause = this.buildSelectClause(state.select);

            // Generate WHERE clause using appropriate dialect (PostgreSQL or SQLite)
            const { whereClause, params: whereParams } = this.generateWhere(
                state.whereData,
                0,
                state.trashedOption,
                state.accessUserIds
            );

            // Use FilterOrder for ORDER BY clause
            const orderClause = FilterOrder.generate(state.order);

            // Build LIMIT/OFFSET clause
            const limitClause = this.buildLimitClause(state.limit, state.offset);

            // Combine all clauses
            const query = [
                `SELECT ${selectClause}`,
                `FROM "${state.tableName}"`,
                whereClause ? `WHERE ${whereClause}` : '',
                orderClause, // FilterOrder already includes "ORDER BY" prefix
                limitClause
            ].filter(Boolean).join(' ');

            console.debug('SQL query generated successfully', {
                tableName: state.tableName,
                paramCount: whereParams.length
            });

            return { query, params: whereParams };
        } catch (error) {
            console.warn('SQL query generation failed', {
                tableName: state.tableName,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Generate WHERE clause with parameters for use in custom queries
     *
     * Returns WHERE clause conditions and parameters that can be used
     * to build COUNT queries or other custom SQL statements.
     */
    static toWhereSQL(state: FilterState): { whereClause: string; params: any[] } {
        try {
            // Generate WHERE clause using appropriate dialect (PostgreSQL or SQLite)
            const result = this.generateWhere(
                state.whereData,
                0,
                state.trashedOption,
                state.accessUserIds
            );

            console.debug('WHERE clause generated successfully', {
                tableName: state.tableName,
                paramCount: result.params.length
            });

            return result;
        } catch (error) {
            console.warn('WHERE clause generation failed', {
                tableName: state.tableName,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Generate COUNT query with parameters
     *
     * Returns a COUNT(*) query using the current filter conditions.
     * Useful for pagination and result count operations.
     */
    static toCountSQL(state: FilterState): { query: string; params: any[] } {
        try {
            const { whereClause, params } = this.toWhereSQL(state);

            let query = `SELECT COUNT(*) as count FROM "${state.tableName}"`;
            if (whereClause) {
                query += ` WHERE ${whereClause}`;
            }

            console.debug('COUNT query generated successfully', {
                tableName: state.tableName,
                paramCount: params.length
            });

            return { query, params };
        } catch (error) {
            console.warn('COUNT query generation failed', {
                tableName: state.tableName,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Generate aggregation query with parameters
     *
     * Returns an aggregation query (SUM, AVG, MIN, MAX, COUNT) with optional GROUP BY.
     * Useful for analytics, dashboards, and statistical queries.
     */
    static toAggregateSQL(
        state: FilterState,
        aggregations: AggregateSpec,
        groupBy?: string[]
    ): { query: string; params: any[] } {
        try {
            // Build aggregation SELECT clause
            const aggregateClause = this.buildAggregateClause(aggregations);

            // Build GROUP BY clause if provided
            const groupByClause = this.buildGroupByClause(groupBy);

            // Get WHERE clause with parameters
            const { whereClause, params } = this.toWhereSQL(state);

            // Build complete query
            const selectParts: string[] = [];

            // Add GROUP BY fields to SELECT
            if (groupBy && groupBy.length > 0) {
                selectParts.push(...groupBy.map(col => `"${this.sanitizeFieldName(col)}"`));
            }

            // Add aggregations to SELECT
            selectParts.push(aggregateClause);

            const query = [
                `SELECT ${selectParts.join(', ')}`,
                `FROM "${state.tableName}"`,
                whereClause ? `WHERE ${whereClause}` : '',
                groupByClause
            ].filter(Boolean).join(' ');

            console.debug('Aggregation query generated successfully', {
                tableName: state.tableName,
                aggregationCount: Object.keys(aggregations).length,
                groupByFields: groupBy?.length || 0,
                paramCount: params.length
            });

            return { query, params };
        } catch (error) {
            console.warn('Aggregation query generation failed', {
                tableName: state.tableName,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Get just the WHERE clause conditions for use in other queries
     */
    static getWhereClause(state: FilterState): string {
        try {
            // Generate WHERE clause using appropriate dialect (PostgreSQL or SQLite)
            const { whereClause } = this.generateWhere(
                state.whereData,
                0,
                state.trashedOption,
                state.accessUserIds
            );
            return whereClause || '1=1';
        } catch (error) {
            console.warn('WHERE clause extraction failed', {
                tableName: state.tableName,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Get just the ORDER BY clause for use in other queries
     */
    static getOrderClause(state: FilterState): string {
        try {
            // Use FilterOrder for consistent ORDER BY generation
            const orderClause = FilterOrder.generate(state.order);

            // Remove "ORDER BY" prefix since getOrderClause() returns just the clause part
            return orderClause.replace(/^ORDER BY\s+/, '');
        } catch (error) {
            console.warn('ORDER clause extraction failed', {
                tableName: state.tableName,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Get just the LIMIT/OFFSET clause for use in other queries
     */
    static getLimitClause(state: FilterState): string {
        return this.buildLimitClause(state.limit, state.offset);
    }

    // ============================================================================
    // Private Helper Methods
    // ============================================================================

    /**
     * Build SELECT clause with proper escaping
     */
    private static buildSelectClause(select: string[]): string {
        if (select.length === 0 || select.includes('*')) {
            return '*';
        }

        return select.map(col => `"${col}"`).join(', ');
    }

    /**
     * Build LIMIT/OFFSET clause
     */
    private static buildLimitClause(limit?: number, offset?: number): string {
        try {
            if (limit !== undefined) {
                let limitClause = `LIMIT ${limit}`;
                if (offset !== undefined) {
                    limitClause += ` OFFSET ${offset}`;
                }
                return limitClause;
            }
            return '';
        } catch (error) {
            console.warn('LIMIT clause generation failed', {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Build aggregation SELECT clause from AggregateSpec
     */
    private static buildAggregateClause(aggregations: AggregateSpec): string {
        const aggregateParts: string[] = [];

        for (const [alias, aggFunc] of Object.entries(aggregations)) {
            // Validate alias
            const sanitizedAlias = this.sanitizeFieldName(alias);

            // Extract function and field
            if ('$count' in aggFunc) {
                const field = aggFunc.$count;
                if (field === '*') {
                    aggregateParts.push(`COUNT(*) as "${sanitizedAlias}"`);
                } else {
                    const sanitizedField = this.sanitizeFieldName(field);
                    aggregateParts.push(`COUNT("${sanitizedField}") as "${sanitizedAlias}"`);
                }
            } else if ('$sum' in aggFunc) {
                const sanitizedField = this.sanitizeFieldName(aggFunc.$sum);
                aggregateParts.push(`SUM("${sanitizedField}") as "${sanitizedAlias}"`);
            } else if ('$avg' in aggFunc) {
                const sanitizedField = this.sanitizeFieldName(aggFunc.$avg);
                aggregateParts.push(`AVG("${sanitizedField}") as "${sanitizedAlias}"`);
            } else if ('$min' in aggFunc) {
                const sanitizedField = this.sanitizeFieldName(aggFunc.$min);
                aggregateParts.push(`MIN("${sanitizedField}") as "${sanitizedAlias}"`);
            } else if ('$max' in aggFunc) {
                const sanitizedField = this.sanitizeFieldName(aggFunc.$max);
                aggregateParts.push(`MAX("${sanitizedField}") as "${sanitizedAlias}"`);
            } else if ('$distinct' in aggFunc) {
                const sanitizedField = this.sanitizeFieldName(aggFunc.$distinct);
                aggregateParts.push(`COUNT(DISTINCT "${sanitizedField}") as "${sanitizedAlias}"`);
            } else {
                throw HttpErrors.badRequest(`Unknown aggregation function for alias '${alias}'`, 'FILTER_INVALID_AGGREGATION');
            }
        }

        if (aggregateParts.length === 0) {
            throw HttpErrors.badRequest('At least one aggregation function required', 'FILTER_NO_AGGREGATIONS');
        }

        return aggregateParts.join(', ');
    }

    /**
     * Build GROUP BY clause with proper escaping
     */
    private static buildGroupByClause(groupBy?: string[]): string {
        if (!groupBy || groupBy.length === 0) {
            return '';
        }

        // Validate and sanitize field names
        const sanitizedFields = groupBy.map(col => {
            const sanitized = this.sanitizeFieldName(col);
            return `"${sanitized}"`;
        });

        return `GROUP BY ${sanitizedFields.join(', ')}`;
    }

    /**
     * Sanitize field name to prevent SQL injection
     */
    private static sanitizeFieldName(field: string): string {
        if (!field || typeof field !== 'string') {
            throw HttpErrors.badRequest('Field name must be a non-empty string', 'FILTER_INVALID_FIELD');
        }

        // Allow alphanumeric and underscore only
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
            throw HttpErrors.badRequest(`Invalid field name format: ${field}`, 'FILTER_INVALID_FIELD_FORMAT');
        }

        return field;
    }

    /**
     * Generate WHERE clause using appropriate dialect (PostgreSQL or SQLite)
     * Factory method that selects the right FilterWhere implementation based on adapterType
     */
    private static generateWhere(
        whereData: any,
        startingParamIndex: number,
        options: FilterWhereOptions,
        accessUserIds: string[]
    ): { whereClause: string; params: any[] } {
        if (options.adapterType === 'sqlite') {
            return FilterWhereSqlite.generate(whereData, startingParamIndex, options, accessUserIds);
        }
        return FilterWhere.generate(whereData, startingParamIndex, options, accessUserIds);
    }
}
