/**
 * Database Select Operations
 *
 * All read operations for the Database service.
 * These operations do not go through the observer pipeline.
 */

import type { SystemContext } from '@src/lib/system-context-types.js';
import type { DatabaseAdapter } from '@src/lib/database/adapter.js';
import type { FilterData } from '@src/lib/filter-types.js';
import type { FilterWhereOptions, AdapterType } from '@src/lib/filter-types.js';
import type { DbRecord } from '@src/lib/database-types.js';
import type { SelectOptions, CachedRelationship } from './types.js';
import { Filter } from '@src/lib/filter.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { convertRecordPgToMonk, FieldTypeMapper } from '@src/lib/field-types.js';

/**
 * Get database adapter from system context
 */
function getAdapter(system: SystemContext): DatabaseAdapter {
    if (!system.adapter) {
        throw new Error('Database adapter not initialized - ensure withTransaction() wrapper is used');
    }
    return system.adapter;
}

/**
 * Get default soft delete options based on context
 */
export function getDefaultSoftDeleteOptions(system: SystemContext, context?: 'api' | 'observer' | 'system'): FilterWhereOptions {
    const adapterType: AdapterType = system.adapter?.getType() || 'postgresql';

    switch (context) {
        case 'observer':
        case 'system':
            return { trashed: 'include', adapterType };
        case 'api':
        default:
            return { trashed: 'exclude', adapterType };
    }
}

/**
 * Convert database results back to proper JSON types
 */
function convertPostgreSQLTypes(system: SystemContext, record: any, model: any): any {
    let converted = record;

    // Convert typed fields (user-defined fields with type metadata)
    if (model.typedFields && model.typedFields.size > 0) {
        converted = convertRecordPgToMonk(converted, model.typedFields);
    }

    // For SQLite: Parse JSON array strings for system fields
    if (system.adapter?.getType() === 'sqlite') {
        converted = convertSqliteJsonArrays(converted);
    }

    return converted;
}

/**
 * Parse SQLite JSON array strings for system fields
 */
function convertSqliteJsonArrays(record: any): any {
    const JSON_ARRAY_FIELDS = ['access_read', 'access_edit', 'access_full', 'access_deny'];

    for (const field of JSON_ARRAY_FIELDS) {
        if (field in record && typeof record[field] === 'string') {
            try {
                record[field] = JSON.parse(record[field]);
            } catch {
                // If parsing fails, leave as-is
            }
        }
    }

    return record;
}

/**
 * Execute raw SQL query
 */
export async function execute(system: SystemContext, query: string, params: any[] = []): Promise<any> {
    return await getAdapter(system).query(query, params);
}

/**
 * Get relationship metadata by parent model and relationship name
 */
export async function getRelationship(
    system: SystemContext,
    parentModel: string,
    relationshipName: string
): Promise<CachedRelationship> {
    const fields = system.namespace.getRelationships(parentModel, relationshipName);
    if (fields.length === 0) {
        throw HttpErrors.notFound(
            `Relationship '${relationshipName}' not found for model '${parentModel}'`,
            'RELATIONSHIP_NOT_FOUND'
        );
    }
    const field = fields[0];
    return {
        fieldName: field.fieldName,
        childModel: field.modelName,
        relationshipType: field.relationshipType || 'owned',
    };
}

/**
 * Count records matching filter criteria
 */
export async function count(
    system: SystemContext,
    modelName: string,
    filterData: FilterData = {},
    options: SelectOptions = {}
): Promise<number> {
    const model = system.namespace.getModel(modelName);
    const defaultOptions = getDefaultSoftDeleteOptions(system, options.context);
    const mergedOptions = { ...defaultOptions, ...options };

    const filter = new Filter(model.model_name)
        .assign(filterData)
        .withAccess([system.userId], system.isSudo())
        .withTrashed(mergedOptions);

    const { query, params } = filter.toCountSQL();
    const result = await execute(system, query, params);

    return parseInt(result.rows[0].count as string);
}

/**
 * Aggregate data with optional GROUP BY
 */
export async function aggregate(
    system: SystemContext,
    modelName: string,
    body: any = {},
    options: SelectOptions = {}
): Promise<any[]> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw HttpErrors.badRequest('Request body must be an object', 'BODY_NOT_OBJECT');
    }

    if (!body.aggregate || typeof body.aggregate !== 'object' || Object.keys(body.aggregate).length === 0) {
        throw HttpErrors.badRequest('Request must include "aggregate" field with at least one aggregation function', 'BODY_MISSING_FIELD');
    }

    const filterData = body.where ? { where: body.where } : {};
    const aggregations = body.aggregate;
    const groupBy = body.groupBy || body.group_by;

    const model = system.namespace.getModel(modelName);
    const defaultOptions = getDefaultSoftDeleteOptions(system, options.context);
    const mergedOptions = { ...defaultOptions, ...options };

    const filter = new Filter(model.model_name)
        .assign(filterData)
        .withAccess([system.userId], system.isSudo())
        .withTrashed(mergedOptions);

    const { query, params } = filter.toAggregateSQL(aggregations, groupBy);
    const result = await execute(system, query, params);

    return result.rows.map((row: any) => convertPostgreSQLTypes(system, row, model));
}

/**
 * Select records matching filter criteria
 */
export async function selectAny<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    filterData: FilterData = {},
    options: SelectOptions = {}
): Promise<DbRecord<T>[]> {
    const model = system.namespace.getModel(modelName);
    const defaultOptions = getDefaultSoftDeleteOptions(system, options.context);
    const mergedOptions = { ...defaultOptions, ...options };

    const filter = new Filter(model.model_name)
        .assign(filterData)
        .withAccess([system.userId], system.isSudo())
        .withTrashed(mergedOptions);

    const { query, params } = filter.toSQL();
    const result = await execute(system, query, params);

    let rows = result.rows.map((row: any) => convertPostgreSQLTypes(system, row, model));

    // Special handling for 'fields' model: convert PG types to user types
    if (modelName === 'fields') {
        rows = rows.map((row: any) => {
            if (row.type) {
                const userType = FieldTypeMapper.toUser(row.type);
                if (userType) {
                    row.type = userType;
                }
            }
            return row;
        });
    }

    return rows;
}

/**
 * Select a single record matching filter criteria
 */
export async function selectOne<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    filterData: FilterData,
    options: SelectOptions = {}
): Promise<DbRecord<T> | null> {
    const results = await selectAny<T>(system, modelName, filterData, options);
    return results[0] || null;
}

/**
 * Select a single record or throw 404 error
 */
export async function select404<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    filter: FilterData,
    message?: string,
    options: SelectOptions = {}
): Promise<DbRecord<T>> {
    const record = await selectOne<T>(system, modelName, filter, options);

    if (!record) {
        throw HttpErrors.notFound(message || 'Record not found', 'RECORD_NOT_FOUND');
    }

    return record;
}

/**
 * Select multiple records by their IDs
 */
export async function selectIds<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    ids: string[],
    options: SelectOptions = {}
): Promise<DbRecord<T>[]> {
    if (ids.length === 0) return [];
    return await selectAny<T>(system, modelName, { where: { id: { $in: ids } } }, options);
}

/**
 * Select multiple records by their IDs (from record objects)
 */
export async function selectAll<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    records: DbRecord<T>[]
): Promise<DbRecord<T>[]> {
    const ids = records.map(record => record.id).filter(id => id !== undefined);

    if (ids.length === 0) {
        return [];
    }

    return await selectAny<T>(system, modelName, { where: { id: { $in: ids } } }, { context: 'system' });
}

// ========================================================================
// Stream Operations
// ========================================================================

/**
 * Stream records matching filter criteria
 *
 * Returns an async generator that yields records one at a time.
 * Useful for large result sets where you want to:
 * - Stream JSONL to HTTP clients
 * - Process records without loading all into memory
 * - Pipe to other streaming consumers (MCP, MQTT, etc.)
 *
 * Note: Current implementation executes query then yields rows.
 * Future optimization: use database cursors for true streaming.
 */
export async function* streamAny<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    filterData: FilterData = {},
    options: SelectOptions = {}
): AsyncGenerator<DbRecord<T>, void, unknown> {
    const model = system.namespace.getModel(modelName);
    const defaultOptions = getDefaultSoftDeleteOptions(system, options.context);
    const mergedOptions = { ...defaultOptions, ...options };

    const filter = new Filter(model.model_name)
        .assign(filterData)
        .withAccess([system.userId], system.isSudo())
        .withTrashed(mergedOptions);

    const { query, params } = filter.toSQL();
    const result = await execute(system, query, params);

    // Yield records one at a time
    for (const row of result.rows) {
        let converted = convertPostgreSQLTypes(system, row, model);

        // Special handling for 'fields' model: convert PG types to user types
        if (modelName === 'fields' && converted.type) {
            const userType = FieldTypeMapper.toUser(converted.type);
            if (userType) {
                converted.type = userType;
            }
        }

        yield converted as DbRecord<T>;
    }
}

/**
 * Stream records by their IDs
 *
 * Returns an async generator that yields records one at a time.
 */
export async function* streamIds<T extends Record<string, any> = Record<string, any>>(
    system: SystemContext,
    modelName: string,
    ids: string[],
    options: SelectOptions = {}
): AsyncGenerator<DbRecord<T>, void, unknown> {
    if (ids.length === 0) return;
    yield* streamAny<T>(system, modelName, { where: { id: { $in: ids } } }, options);
}
