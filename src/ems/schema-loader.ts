/**
 * Schema Loader - Load JSON model/field/seed definitions
 *
 * Loads schema definitions from JSON files and applies them via EMS upsert.
 * This allows subsystems to define their schemas in a dialect-agnostic way.
 *
 * Directory structure expected:
 * - {basePath}/models/{model_name}.json
 * - {basePath}/fields/{model_name}.{field_name}.json
 * - {basePath}/seeds/{NN}-{description}.json
 *
 * Load order:
 * 1. Models (sorted alphabetically) - triggers DdlCreateModel observer
 * 2. Fields (sorted alphabetically) - triggers DdlCreateField observer
 * 3. Seeds (sorted by filename prefix) - populates initial data
 */

import { readdir } from 'fs/promises';
import { join } from 'path';

/**
 * Fields in the `fields` table that are stored as TEXT but may be arrays in JSON.
 */
const ARRAY_TEXT_FIELDS = new Set(['enum_values']);

/**
 * Normalize field data for database insertion.
 *
 * WHY: Field definitions have properties like `enum_values` that are stored as TEXT
 * in SQLite but we want to allow arrays in JSON for better readability.
 */
function normalizeFieldData(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...data };

    for (const field of ARRAY_TEXT_FIELDS) {
        if (Array.isArray(result[field])) {
            result[field] = JSON.stringify(result[field]);
        }
    }

    return result;
}

/**
 * Upsert options for schema loading.
 */
export interface SchemaUpsertOptions {
    key?: string | string[];
}

/**
 * Minimal interface for EMS operations needed by the loader.
 * Accepts EntityOps or any compatible implementation.
 *
 * WHY not import EntityOps directly: Keeps schema-loader decoupled,
 * allowing testing with mock implementations.
 */
export interface SchemaOps {
    upsertAll(model: string, source: Iterable<unknown>, options?: SchemaUpsertOptions): AsyncGenerator<unknown>;
}

/**
 * Result of loading a schema component (model, field, or seed).
 */
export interface LoadResult {
    type: 'model' | 'field' | 'seed';
    file: string;
    data: unknown;
}

/**
 * Load all JSON files from a directory, sorted by filename.
 */
async function loadJsonFiles(dir: string): Promise<Array<{ file: string; data: unknown }>> {
    const results: Array<{ file: string; data: unknown }> = [];

    let entries: string[];

    try {
        entries = await readdir(dir);
    }
    catch (err) {
        // Directory doesn't exist - that's fine, just return empty
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }

        throw err;
    }

    // Filter for JSON files and sort
    const jsonFiles = entries.filter(f => f.endsWith('.json')).sort();

    for (const file of jsonFiles) {
        const filePath = join(dir, file);
        const bunFile = Bun.file(filePath);
        const data = await bunFile.json();

        results.push({ file, data });
    }

    return results;
}

/**
 * Load schema definitions from JSON files and apply via EMS upsert.
 *
 * @param basePath - Directory containing models/, fields/, seeds/ subdirectories
 * @param ops - EMS operations interface with upsertAll method
 *
 * @example
 * ```typescript
 * // In VFS.init():
 * const schemaPath = join(import.meta.dir, '.');
 * for await (const result of loadSchema(schemaPath, ems.ops)) {
 *     // Each model/field/seed loaded and applied
 * }
 * ```
 */
export async function* loadSchema(
    basePath: string,
    ops: SchemaOps,
): AsyncGenerator<LoadResult> {
    // 1. Load and upsert models (triggers DdlCreateModel observer)
    // WHY key: model_name is the natural key, not id
    const modelFiles = await loadJsonFiles(join(basePath, 'models'));

    for (const { file, data } of modelFiles) {
        // WHY: drain the generator to ensure upsert completes
        for await (const _ of ops.upsertAll('models', [data], { key: 'model_name' })) {
            // Upsert yields the created/updated record
        }

        yield { type: 'model', file, data };
    }

    // 2. Load and upsert fields (triggers DdlCreateField observer)
    // WHY key: (model_name, field_name) is the composite natural key
    const fieldFiles = await loadJsonFiles(join(basePath, 'fields'));

    for (const { file, data } of fieldFiles) {
        // WHY normalize: Some fields (enum_values) are stored as TEXT in SQLite
        // but we want to allow arrays in JSON for readability
        const normalizedData = normalizeFieldData(data as Record<string, unknown>);

        for await (const _ of ops.upsertAll('fields', [normalizedData], { key: ['model_name', 'field_name'] })) {
            // Upsert yields the created/updated record
        }

        yield { type: 'field', file, data };
    }

    // 3. Load and upsert seeds
    const seedFiles = await loadJsonFiles(join(basePath, 'seeds'));

    for (const { file, data } of seedFiles) {
        // Seeds can be a single object or an array
        const seeds = Array.isArray(data) ? data : [data];

        for (const seed of seeds) {
            const { model, data: seedData } = seed as { model: string; data: unknown };

            for await (const _ of ops.upsertAll(model, [seedData])) {
                // Upsert yields the created/updated record
            }
        }

        yield { type: 'seed', file, data };
    }
}

/**
 * Convenience function to load schema without yielding results.
 *
 * @param basePath - Directory containing models/, fields/, seeds/ subdirectories
 * @param ops - EMS operations interface with upsertAll method
 */
export async function loadSchemaSync(basePath: string, ops: SchemaOps): Promise<void> {
    for await (const _ of loadSchema(basePath, ops)) {
        // Drain the generator
    }
}
