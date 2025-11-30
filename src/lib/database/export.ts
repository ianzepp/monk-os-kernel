/**
 * Database Export Module
 *
 * Exports tenant data to SQLite format for:
 * - Bulk data export/import
 * - Snapshots and backups
 * - Data migration between tenants
 */

import { Database as SqliteDatabase } from 'bun:sqlite';
import type { SystemContext } from '@src/lib/system-context-types.js';
import type { ModelRecord, FieldRecord } from '@src/lib/database-types.js';
import { USER_TO_SQLITE, SQLITE_SYSTEM_COLUMNS } from './type-mappings.js';
import * as selectOps from './select.js';

/**
 * Export options
 */
export interface ExportOptions {
    /** Specific models to export (null = all non-system models) */
    models?: string[];
    /** What to include in export */
    include?: ('describe' | 'data')[];
    /** Strip access_* fields (set to empty arrays) - useful for test fixtures */
    stripAccess?: boolean;
}

/**
 * Export result with SQLite buffer and metadata
 */
export interface ExportResult {
    /** SQLite database as binary buffer */
    buffer: Uint8Array;
    /** Export metadata */
    meta: {
        version: string;
        exported_at: string;
        models: string[];
        include: string[];
        record_counts: Record<string, number>;
    };
}

/**
 * Export tenant data to SQLite format
 *
 * Creates an in-memory SQLite database containing:
 * - _meta: Export metadata (version, timestamp, included models)
 * - models: Model definitions (if include has 'describe')
 * - fields: Field definitions (if include has 'describe')
 * - {model}: Data tables for each model (if include has 'data')
 *
 * @param system - System context for database access
 * @param options - Export options
 * @returns Export result with SQLite buffer and metadata
 */
export async function exportAll(
    system: SystemContext,
    options: ExportOptions = {}
): Promise<ExportResult> {
    const { models: requestedModels, include = ['describe', 'data'], stripAccess = false } = options;

    const includeDescribe = include.includes('describe');
    const includeData = include.includes('data');
    const recordCounts: Record<string, number> = {};

    // Get non-system models
    let models = await selectOps.selectAny<ModelRecord>(system, 'models', {
        where: { status: { $ne: 'system' } },
    });

    // Filter to requested models if specified
    if (requestedModels && requestedModels.length > 0) {
        const requestedSet = new Set(requestedModels);
        models = models.filter(m => requestedSet.has(m.model_name));
    }

    const modelNames = models.map(m => m.model_name);

    // Get fields for selected models
    const fields = modelNames.length > 0
        ? await selectOps.selectAny<FieldRecord>(system, 'fields', {
            where: { model_name: { $in: modelNames } },
        })
        : [];

    // Create in-memory SQLite database
    const exportDb = new SqliteDatabase(':memory:');

    try {
        // Create _meta table
        exportDb.exec(`
            CREATE TABLE _meta (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);

        if (includeDescribe) {
            createDescribeTables(exportDb, models, fields, stripAccess);
        }

        if (includeData) {
            await exportDataTables(system, exportDb, models, fields, recordCounts, stripAccess);
        }

        // Build metadata
        const meta = {
            version: '1.0',
            exported_at: new Date().toISOString(),
            models: modelNames,
            include: include,
            record_counts: recordCounts,
        };

        // Insert metadata
        exportDb.run(
            'INSERT INTO _meta (key, value) VALUES (?, ?)',
            ['export', JSON.stringify(meta)]
        );

        // Serialize database to buffer
        const buffer = exportDb.serialize();

        return { buffer, meta };

    } finally {
        exportDb.close();
    }
}

/**
 * Create and populate models/fields tables
 */
function createDescribeTables(
    exportDb: SqliteDatabase,
    models: ModelRecord[],
    fields: FieldRecord[],
    stripAccess: boolean
): void {
    const emptyAccess = '[]';
    // Create models table
    exportDb.exec(`
        CREATE TABLE models (
            ${SQLITE_SYSTEM_COLUMNS},
            model_name TEXT NOT NULL,
            status TEXT,
            description TEXT,
            sudo INTEGER,
            external INTEGER,
            immutable INTEGER
        )
    `);

    // Insert models
    const modelStmt = exportDb.prepare(`
        INSERT INTO models (id, access_read, access_edit, access_full, access_deny,
            created_at, updated_at, trashed_at, deleted_at,
            model_name, status, description, sudo, external, immutable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const model of models) {
        modelStmt.run(
            model.id,
            stripAccess ? emptyAccess : JSON.stringify(model.access_read || []),
            stripAccess ? emptyAccess : JSON.stringify(model.access_edit || []),
            stripAccess ? emptyAccess : JSON.stringify(model.access_full || []),
            stripAccess ? emptyAccess : JSON.stringify(model.access_deny || []),
            model.created_at,
            model.updated_at,
            model.trashed_at ?? null,
            model.deleted_at ?? null,
            model.model_name,
            model.status,
            (model as any).description ?? null,
            (model as any).sudo ? 1 : 0,
            (model as any).external ? 1 : 0,
            (model as any).immutable ? 1 : 0
        );
    }

    // Create fields table
    exportDb.exec(`
        CREATE TABLE fields (
            ${SQLITE_SYSTEM_COLUMNS},
            model_name TEXT NOT NULL,
            field_name TEXT NOT NULL,
            type TEXT NOT NULL,
            required INTEGER,
            default_value TEXT,
            description TEXT,
            pattern TEXT,
            minimum REAL,
            maximum REAL,
            min_length INTEGER,
            max_length INTEGER,
            enum_values TEXT,
            relationship_type TEXT,
            relationship_model TEXT,
            relationship_name TEXT,
            relationship_field TEXT,
            relationship_cascade_delete INTEGER,
            relationship_required INTEGER
        )
    `);

    // Insert fields
    const fieldStmt = exportDb.prepare(`
        INSERT INTO fields (id, access_read, access_edit, access_full, access_deny,
            created_at, updated_at, trashed_at, deleted_at,
            model_name, field_name, type, required, default_value, description,
            pattern, minimum, maximum, min_length, max_length, enum_values,
            relationship_type, relationship_model, relationship_name,
            relationship_field, relationship_cascade_delete, relationship_required)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const field of fields) {
        fieldStmt.run(
            field.id,
            stripAccess ? emptyAccess : JSON.stringify(field.access_read || []),
            stripAccess ? emptyAccess : JSON.stringify(field.access_edit || []),
            stripAccess ? emptyAccess : JSON.stringify(field.access_full || []),
            stripAccess ? emptyAccess : JSON.stringify(field.access_deny || []),
            field.created_at,
            field.updated_at,
            field.trashed_at ?? null,
            field.deleted_at ?? null,
            field.model_name,
            field.field_name,
            field.type,
            field.required ? 1 : 0,
            field.default_value !== undefined ? JSON.stringify(field.default_value) : null,
            field.description ?? null,
            field.pattern ?? null,
            field.minimum ?? null,
            field.maximum ?? null,
            field.min_length ?? null,
            field.max_length ?? null,
            field.enum_values ? JSON.stringify(field.enum_values) : null,
            field.relationship_type ?? null,
            field.relationship_model ?? null,
            field.relationship_name ?? null,
            field.relationship_field ?? null,
            field.relationship_cascade_delete ? 1 : 0,
            field.relationship_required ? 1 : 0
        );
    }
}

/**
 * Create and populate data tables for each model
 */
async function exportDataTables(
    system: SystemContext,
    exportDb: SqliteDatabase,
    models: ModelRecord[],
    fields: FieldRecord[],
    recordCounts: Record<string, number>,
    stripAccess: boolean
): Promise<void> {
    const emptyAccess = '[]';
    // Group fields by model for table creation
    const fieldsByModel = new Map<string, FieldRecord[]>();
    for (const field of fields) {
        const modelFields = fieldsByModel.get(field.model_name) || [];
        modelFields.push(field);
        fieldsByModel.set(field.model_name, modelFields);
    }

    // Export data for each model
    for (const model of models) {
        const modelFields = fieldsByModel.get(model.model_name) || [];

        // Build CREATE TABLE statement
        const columnDefs = [SQLITE_SYSTEM_COLUMNS];
        for (const field of modelFields) {
            const sqliteType = USER_TO_SQLITE[field.type] || 'TEXT';
            columnDefs.push(`"${field.field_name}" ${sqliteType}`);
        }

        exportDb.exec(`CREATE TABLE "${model.model_name}" (${columnDefs.join(', ')})`);

        // Get all records for this model
        const records = await selectOps.selectAny(system, model.model_name, {});
        recordCounts[model.model_name] = records.length;

        if (records.length > 0) {
            // Build INSERT statement
            const systemCols = ['id', 'access_read', 'access_edit', 'access_full', 'access_deny',
                'created_at', 'updated_at', 'trashed_at', 'deleted_at'];
            const fieldCols = modelFields.map(f => f.field_name);
            const allCols = [...systemCols, ...fieldCols];
            const placeholders = allCols.map(() => '?').join(', ');

            const insertStmt = exportDb.prepare(
                `INSERT INTO "${model.model_name}" (${allCols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`
            );

            for (const record of records) {
                const values = [
                    record.id,
                    stripAccess ? emptyAccess : JSON.stringify(record.access_read || []),
                    stripAccess ? emptyAccess : JSON.stringify(record.access_edit || []),
                    stripAccess ? emptyAccess : JSON.stringify(record.access_full || []),
                    stripAccess ? emptyAccess : JSON.stringify(record.access_deny || []),
                    record.created_at,
                    record.updated_at,
                    record.trashed_at ?? null,
                    record.deleted_at ?? null,
                    ...fieldCols.map(col => {
                        const val = record[col];
                        if (val === null || val === undefined) return null;
                        if (typeof val === 'object') return JSON.stringify(val);
                        return val;
                    })
                ];
                insertStmt.run(...values);
            }
        }
    }
}
