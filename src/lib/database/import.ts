/**
 * Database Import Module
 *
 * Imports tenant data from SQLite format for:
 * - Bulk data import
 * - Restoring from snapshots/backups
 * - Data migration between tenants
 */

import { Database as SqliteDatabase } from 'bun:sqlite';
import type { SystemContext } from '@src/lib/system-context-types.js';
import type { DbRecord } from '@src/lib/database-types.js';
import * as mutateOps from './mutate.js';
import * as selectOps from './select.js';

/**
 * Import conflict strategies
 */
export type ImportStrategy =
    | 'upsert'   // Update existing by ID, insert new (default)
    | 'replace'  // Delete all existing, import fresh
    | 'merge'    // Only import data for newly-created models
    | 'skip';    // Skip existing records silently

/**
 * Import options
 */
export interface ImportOptions {
    /** Conflict resolution strategy */
    strategy?: ImportStrategy;
    /** Specific models to import (null = all in file) */
    models?: string[];
    /** What to import from file */
    include?: ('describe' | 'data')[];
}

/**
 * Import result with statistics
 */
export interface ImportResult {
    /** Import metadata from file */
    meta: {
        version: string;
        exported_at: string;
        models: string[];
    };
    /** Import statistics */
    stats: {
        models_created: number;
        models_updated: number;
        fields_created: number;
        fields_updated: number;
        records_created: number;
        records_updated: number;
        records_skipped: number;
    };
}

/**
 * Import tenant data from SQLite format
 *
 * Reads an SQLite database containing:
 * - _meta: Import metadata (version, timestamp, included models)
 * - models: Model definitions (if present)
 * - fields: Field definitions (if present)
 * - {model}: Data tables for each model
 *
 * @param system - System context for database access
 * @param buffer - SQLite database as binary buffer
 * @param options - Import options
 * @returns Import result with statistics
 */
export async function importAll(
    system: SystemContext,
    buffer: Uint8Array,
    options: ImportOptions = {}
): Promise<ImportResult> {
    const {
        strategy = 'upsert',
        models: requestedModels,
        include = ['describe', 'data']
    } = options;

    const includeDescribe = include.includes('describe');
    const includeData = include.includes('data');

    const stats = {
        models_created: 0,
        models_updated: 0,
        fields_created: 0,
        fields_updated: 0,
        records_created: 0,
        records_updated: 0,
        records_skipped: 0,
    };

    // Open SQLite database from buffer
    // Note: bun:sqlite accepts Buffer/Uint8Array for in-memory databases
    const importDb = new SqliteDatabase(buffer as any);

    try {
        // Read metadata
        const metaRow = importDb.query('SELECT value FROM _meta WHERE key = ?').get('export') as { value: string } | null;
        if (!metaRow) {
            throw new Error('Invalid import file: missing _meta table');
        }

        const meta = JSON.parse(metaRow.value);

        // Get list of models to import
        let modelNames: string[] = meta.models || [];
        if (requestedModels && requestedModels.length > 0) {
            const requestedSet = new Set(requestedModels);
            modelNames = modelNames.filter(m => requestedSet.has(m));
        }

        // Check which tables exist in the import file
        const tables = importDb.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_%'"
        ).all() as { name: string }[];
        const tableSet = new Set(tables.map(t => t.name));

        const hasModelsTable = tableSet.has('models');
        const hasFieldsTable = tableSet.has('fields');

        // Import describe (models + fields) if requested and present
        if (includeDescribe && hasModelsTable) {
            await importDescribe(system, importDb, modelNames, strategy, stats);
        }

        // Import data if requested
        if (includeData) {
            // Determine which models to import data for
            const dataModels = modelNames.filter(m => tableSet.has(m));
            await importData(system, importDb, dataModels, strategy, stats, hasFieldsTable);
        }

        return {
            meta: {
                version: meta.version,
                exported_at: meta.exported_at,
                models: modelNames,
            },
            stats,
        };

    } finally {
        importDb.close();
    }
}

/**
 * Import model and field definitions
 */
async function importDescribe(
    system: SystemContext,
    importDb: SqliteDatabase,
    modelNames: string[],
    strategy: ImportStrategy,
    stats: ImportResult['stats']
): Promise<void> {
    // Get existing models
    const existingModels = await selectOps.selectAny(system, 'models', {
        where: { model_name: { $in: modelNames } },
    });
    const existingModelSet = new Set(existingModels.map(m => m.model_name));

    // Read models from import file
    const importModels = importDb.query(
        `SELECT * FROM models WHERE model_name IN (${modelNames.map(() => '?').join(', ')})`
    ).all(...modelNames) as any[];

    for (const model of importModels) {
        const modelData = parseModelRow(model);
        const exists = existingModelSet.has(model.model_name);

        if (strategy === 'skip' && exists) {
            continue;
        }

        if (strategy === 'merge' && exists) {
            continue;
        }

        if (exists) {
            // Update existing model
            await mutateOps.updateOne(system, 'models', model.id, modelData);
            stats.models_updated++;
        } else {
            // Create new model
            await mutateOps.createOne(system, 'models', { id: model.id, ...modelData });
            stats.models_created++;
        }
    }

    // Import fields for the models
    const importFields = importDb.query(
        `SELECT * FROM fields WHERE model_name IN (${modelNames.map(() => '?').join(', ')})`
    ).all(...modelNames) as any[];

    // Get existing fields
    const existingFields = await selectOps.selectAny(system, 'fields', {
        where: { model_name: { $in: modelNames } },
    });
    const existingFieldMap = new Map(
        existingFields.map(f => [`${f.model_name}.${f.field_name}`, f])
    );

    for (const field of importFields) {
        const fieldData = parseFieldRow(field);
        const fieldKey = `${field.model_name}.${field.field_name}`;
        const existingField = existingFieldMap.get(fieldKey);

        if (strategy === 'skip' && existingField) {
            continue;
        }

        if (strategy === 'merge' && existingField) {
            continue;
        }

        if (existingField) {
            // Update existing field
            await mutateOps.updateOne(system, 'fields', existingField.id, fieldData);
            stats.fields_updated++;
        } else {
            // Create new field
            await mutateOps.createOne(system, 'fields', { id: field.id, ...fieldData });
            stats.fields_created++;
        }
    }
}

/**
 * Import data records for each model
 */
async function importData(
    system: SystemContext,
    importDb: SqliteDatabase,
    modelNames: string[],
    strategy: ImportStrategy,
    stats: ImportResult['stats'],
    hasFieldsTable: boolean
): Promise<void> {
    for (const modelName of modelNames) {
        // Get field info to know which columns are JSON
        let jsonFields = new Set<string>();
        if (hasFieldsTable) {
            const fields = importDb.query(
                'SELECT field_name, type FROM fields WHERE model_name = ?'
            ).all(modelName) as { field_name: string; type: string }[];

            for (const f of fields) {
                if (f.type.endsWith('[]') || f.type === 'jsonb') {
                    jsonFields.add(f.field_name);
                }
            }
        }

        // Always treat access fields as JSON
        ['access_read', 'access_edit', 'access_full', 'access_deny'].forEach(f => jsonFields.add(f));

        // Handle replace strategy - delete all existing records first
        if (strategy === 'replace') {
            const existing = await selectOps.selectAny(system, modelName, {});
            if (existing.length > 0) {
                await mutateOps.deleteIds(system, modelName, existing.map(r => r.id));
            }
        }

        // Read records from import file
        const records = importDb.query(`SELECT * FROM "${modelName}"`).all() as any[];

        if (records.length === 0) {
            continue;
        }

        // Get existing record IDs for this model
        const existingRecords = await selectOps.selectAny(system, modelName, {});
        const existingIdSet = new Set(existingRecords.map(r => r.id));

        // Prepare records for import
        const toCreate: any[] = [];
        const toUpdate: any[] = [];

        for (const record of records) {
            const parsed = parseDataRow(record, jsonFields);
            const exists = existingIdSet.has(record.id);

            if (strategy === 'skip' && exists) {
                stats.records_skipped++;
                continue;
            }

            if (strategy === 'merge' && exists) {
                stats.records_skipped++;
                continue;
            }

            if (exists && strategy !== 'replace') {
                toUpdate.push({ id: record.id, ...parsed });
            } else {
                toCreate.push({ id: record.id, ...parsed });
            }
        }

        // Batch create new records
        if (toCreate.length > 0) {
            await mutateOps.createAll(system, modelName, toCreate);
            stats.records_created += toCreate.length;
        }

        // Batch update existing records
        if (toUpdate.length > 0) {
            await mutateOps.updateAll(system, modelName, toUpdate);
            stats.records_updated += toUpdate.length;
        }
    }
}

/**
 * Parse SQLite model row to model data
 */
function parseModelRow(row: any): Record<string, any> {
    return {
        model_name: row.model_name,
        status: row.status,
        description: row.description,
        sudo: row.sudo === 1,
        external: row.external === 1,
        immutable: row.immutable === 1,
        access_read: parseJsonField(row.access_read),
        access_edit: parseJsonField(row.access_edit),
        access_full: parseJsonField(row.access_full),
        access_deny: parseJsonField(row.access_deny),
    };
}

/**
 * Parse SQLite field row to field data
 */
function parseFieldRow(row: any): Record<string, any> {
    return {
        model_name: row.model_name,
        field_name: row.field_name,
        type: row.type,
        required: row.required === 1,
        default_value: parseJsonField(row.default_value),
        description: row.description,
        pattern: row.pattern,
        minimum: row.minimum,
        maximum: row.maximum,
        min_length: row.min_length,
        max_length: row.max_length,
        enum_values: parseJsonField(row.enum_values),
        relationship_type: row.relationship_type,
        relationship_model: row.relationship_model,
        relationship_name: row.relationship_name,
        relationship_field: row.relationship_field,
        relationship_cascade_delete: row.relationship_cascade_delete === 1,
        relationship_required: row.relationship_required === 1,
        access_read: parseJsonField(row.access_read),
        access_edit: parseJsonField(row.access_edit),
        access_full: parseJsonField(row.access_full),
        access_deny: parseJsonField(row.access_deny),
    };
}

/**
 * Parse SQLite data row
 */
function parseDataRow(row: any, jsonFields: Set<string>): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(row)) {
        // Skip id - handled separately
        if (key === 'id') continue;

        if (jsonFields.has(key) && typeof value === 'string') {
            result[key] = parseJsonField(value);
        } else {
            result[key] = value;
        }
    }

    return result;
}

/**
 * Parse JSON field from SQLite (stored as TEXT)
 */
function parseJsonField(value: any): any {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }
    return value;
}
