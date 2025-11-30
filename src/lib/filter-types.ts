/**
 * Shared types and enums for Filter system
 *
 * This file contains all shared interfaces and enums used across
 * Filter, FilterWhere, and FilterOrder classes to eliminate duplication
 * and ensure consistency.
 */

export enum FilterOp {
    // Comparison operators
    EQ = '$eq',
    NE = '$ne',
    NEQ = '$neq',
    GT = '$gt',
    GTE = '$gte',
    LT = '$lt',
    LTE = '$lte',

    // Pattern matching operators
    LIKE = '$like',
    NLIKE = '$nlike',
    ILIKE = '$ilike',
    NILIKE = '$nilike',
    REGEX = '$regex',
    NREGEX = '$nregex',

    // Array membership operators
    IN = '$in',
    NIN = '$nin',

    // PostgreSQL array operations (CRITICAL for ACL)
    ANY = '$any', // Array overlap: access_read && ARRAY[user_id, group_id]
    ALL = '$all', // Array contains: tags @> ARRAY['feature', 'backend']
    NANY = '$nany', // NOT array overlap: NOT (access_deny && ARRAY[user_id])
    NALL = '$nall', // NOT array contains: NOT (permissions @> ARRAY['editor'])
    SIZE = '$size', // Array size: array_length(tags, 1) = 3

    // Logical operators (CRITICAL for FS wildcards)
    AND = '$and', // Explicit AND: { $and: [condition1, condition2] }
    OR = '$or', // OR conditions: { $or: [{ access: 'root' }, { access: 'full' }] }
    NOT = '$not', // NOT condition: { $not: { status: 'banned' } }
    NAND = '$nand', // NAND operations
    NOR = '$nor', // NOR operations

    // Range operations
    BETWEEN = '$between', // Range: { age: { $between: [18, 65] } } → age BETWEEN 18 AND 65

    // Search operations
    FIND = '$find', // Full-text search: { content: { $find: 'search terms' } }
    TEXT = '$text', // Text search: { description: { $text: 'keyword' } }
    SEARCH = '$search', // PostgreSQL full-text search: { content: { $search: 'typescript programming' } }

    // Existence operators
    EXISTS = '$exists', // Field exists: { field: { $exists: true } } → field IS NOT NULL
    NULL = '$null', // Field is null: { field: { $null: true } } → field IS NULL
}

export interface FilterWhereInfo {
    field: string;
    operator: FilterOp;
    data: any;
}

export type TrashedOption = 'exclude' | 'include' | 'only';
export type AdapterType = 'postgresql' | 'sqlite';

export interface FilterWhereOptions {
    trashed?: TrashedOption;
    adapterType?: AdapterType;
}

// New tree structure for complex logical operators
export interface ConditionNode {
    type: 'condition' | 'logical';

    // For condition nodes
    field?: string;
    operator?: FilterOp;
    data?: any;

    // For logical nodes
    logicalOp?: '$and' | '$or' | '$not';
    children?: ConditionNode[];
}

export type SortDirection = 'asc' | 'desc' | 'ASC' | 'DESC';

export interface FilterOrderInfo {
    field: string;
    sort: 'asc' | 'desc';
}

export interface FilterData {
    model?: string;
    select?: string[];
    where?: any;
    order?: any;
    limit?: number;
    offset?: number;
    lookups?: any;
    related?: any;
    options?: any;
    count?: boolean;  // Include total count in response
    includeTotal?: boolean;  // Alias for count
}

/**
 * Aggregation function types
 */
export type AggregateFunction =
    | { $count: string | '*' }
    | { $sum: string }
    | { $avg: string }
    | { $min: string }
    | { $max: string }
    | { $distinct: string };  // COUNT(DISTINCT field)

/**
 * Aggregation specification for aggregate queries
 */
export interface AggregateSpec {
    [key: string]: AggregateFunction;
}

/**
 * Filter data for aggregation queries
 */
export interface AggregateData {
    where?: any;
    aggregate: AggregateSpec;
    groupBy?: string[];
}
