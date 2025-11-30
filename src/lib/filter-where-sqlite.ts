/**
 * FilterWhereSqlite - SQLite-specific WHERE clause generation
 *
 * Extends FilterWhere to handle SQLite dialect differences:
 * - ILIKE → LIKE COLLATE NOCASE
 * - REGEX → regexp() function (registered in SqliteAdapter)
 * - $search → not supported (requires PostgreSQL tsvector)
 * - Array operators ($any, $all, etc.) → not supported (ACLs disabled for SQLite)
 * - $size → json_array_length() instead of array_length()
 *
 * All other operators delegate to the parent PostgreSQL implementation.
 */

import { FilterWhere } from '@src/lib/filter-where.js';
import { FilterOp, type FilterWhereInfo } from '@src/lib/filter-types.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

export class FilterWhereSqlite extends FilterWhere {
    /**
     * Static method for SQLite WHERE clause generation with validation
     */
    static generate(whereData: any, startingParamIndex: number = 0, options: import('@src/lib/filter-types.js').FilterWhereOptions = {}, accessUserIds: string[] = []): { whereClause: string; params: any[] } {
        try {
            // Validate using parent's validation (same for all dialects)
            FilterWhere.validateWhereData(whereData);

            const filterWhere = new FilterWhereSqlite(startingParamIndex);
            return filterWhere.build(whereData, options, accessUserIds);
        } catch (error) {
            console.warn('FilterWhereSqlite validation failed', {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Factory method override to ensure nested conditions use SQLite dialect
     */
    protected createNestedFilter(startIndex: number): FilterWhere {
        return new FilterWhereSqlite(startIndex);
    }

    /**
     * Build individual SQL condition with SQLite-specific syntax
     * Handles dialect differences, delegates to parent for shared operators
     */
    protected buildSQLCondition(whereInfo: FilterWhereInfo): string | null {
        const { field, operator, data } = whereInfo;

        // No field means logical operator - parent handles these identically
        if (!field) {
            return super.buildSQLCondition(whereInfo);
        }

        const quotedField = `"${field}"`;

        switch (operator) {
            // SQLite: ILIKE → LIKE COLLATE NOCASE
            case FilterOp.ILIKE:
                return `${quotedField} LIKE ${this.PARAM(data)} COLLATE NOCASE`;

            case FilterOp.NILIKE:
                return `${quotedField} NOT LIKE ${this.PARAM(data)} COLLATE NOCASE`;

            // SQLite: Use regexp() function (registered in SqliteAdapter.connect())
            case FilterOp.REGEX:
                return `regexp(${this.PARAM(data)}, ${quotedField})`;

            case FilterOp.NREGEX:
                return `NOT regexp(${this.PARAM(data)}, ${quotedField})`;

            // SQLite: $find/$text use LIKE COLLATE NOCASE (parent uses ILIKE)
            case FilterOp.FIND:
                return `${quotedField} LIKE ${this.PARAM(`%${data}%`)} COLLATE NOCASE`;

            case FilterOp.TEXT:
                return `${quotedField} LIKE ${this.PARAM(`%${data}%`)} COLLATE NOCASE`;

            // SQLite: $search not supported (requires PostgreSQL full-text search)
            case FilterOp.SEARCH:
                throw HttpErrors.badRequest(
                    '$search operator not supported on SQLite (requires PostgreSQL full-text search)',
                    'FILTER_UNSUPPORTED_SQLITE'
                );

            // SQLite: Array operators not supported (ACLs disabled for SQLite tenants)
            case FilterOp.ANY:
            case FilterOp.ALL:
            case FilterOp.NANY:
            case FilterOp.NALL:
                throw HttpErrors.badRequest(
                    `${operator} operator not supported on SQLite (array operators require PostgreSQL)`,
                    'FILTER_UNSUPPORTED_SQLITE'
                );

            // SQLite: $size uses json_array_length() instead of array_length()
            case FilterOp.SIZE:
                if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
                    // Handle nested operators: { $size: { $gte: 1 } }
                    const entries = Object.entries(data);
                    if (entries.length === 1) {
                        const [nestedOp, nestedValue] = entries[0];
                        const arrayLengthExpression = `json_array_length(${quotedField})`;
                        return this.buildSizeOperatorSQL(arrayLengthExpression, nestedOp as FilterOp, nestedValue);
                    }
                }
                return `json_array_length(${quotedField}) = ${this.PARAM(data)}`;

            // All other operators: delegate to parent (PostgreSQL syntax works for SQLite)
            default:
                return super.buildSQLCondition(whereInfo);
        }
    }

    /**
     * Build ACL access clause for SQLite
     * SQLite stores arrays as JSON, so we use json_each() to check membership
     * User has access if their ID appears in access_read, access_edit, or access_full arrays
     * AND none of their IDs appear in access_deny
     */
    protected buildAccessClause(userIds: string[]): string {
        // SQLite: Check if any userIds exist in the JSON arrays
        // Uses EXISTS with json_each() to check array membership
        const allowConditions = userIds.map(id => {
            const param = this.PARAM(id);
            return `(
                EXISTS (SELECT 1 FROM json_each("access_read") WHERE value = ${param}) OR
                EXISTS (SELECT 1 FROM json_each("access_edit") WHERE value = ${param}) OR
                EXISTS (SELECT 1 FROM json_each("access_full") WHERE value = ${param})
            )`;
        });

        // Check that none of the userIds are in the deny list
        const denyConditions = userIds.map(id => {
            const param = this.PARAM(id);
            return `NOT EXISTS (SELECT 1 FROM json_each("access_deny") WHERE value = ${param})`;
        });

        return `((${allowConditions.join(' OR ')}) AND (${denyConditions.join(' AND ')}))`;
    }
}
