/**
 * Load app schemas from /app directories.
 *
 * Scans /app/{name}/ directories for models/ and fields/ subdirectories
 * and loads JSON schema definitions via EMS upsert.
 *
 * Directory structure expected:
 * - /app/{name}/models/{model_name}.json
 * - /app/{name}/fields/{model_name}.{field_name}.json
 *
 * @module kernel/kernel/load-app-schemas
 */

import type { Kernel } from '../kernel.js';
import type { SchemaOps } from '@src/ems/schema-loader.js';
import { printk } from './printk.js';

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
 * Read a file from VFS and parse as JSON.
 */
async function readJsonFromVfs(
    kernel: Kernel,
    path: string,
): Promise<unknown> {
    const handle = await kernel.vfs.open(path, { read: true }, 'kernel');
    const chunks: Uint8Array[] = [];

    while (true) {
        const chunk = await handle.read(65536);

        if (chunk.length === 0) {
            break;
        }

        chunks.push(chunk);
    }

    await handle.close();

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }

    const content = new TextDecoder().decode(combined);

    return JSON.parse(content);
}

/**
 * Load JSON files from a VFS directory.
 */
async function loadJsonFilesFromVfs(
    kernel: Kernel,
    dir: string,
): Promise<Array<{ file: string; data: unknown }>> {
    const results: Array<{ file: string; data: unknown }> = [];

    // Check if directory exists
    try {
        await kernel.vfs.stat(dir, 'kernel');
    }
    catch {
        return [];
    }

    // Read directory entries
    const entries: Array<{ name: string; model: string }> = [];

    for await (const entry of kernel.vfs.readdir(dir, 'kernel')) {
        entries.push(entry);
    }

    // Filter for JSON files and sort
    const jsonFiles = entries
        .filter(e => e.model === 'file' && e.name.endsWith('.json'))
        .map(e => e.name)
        .sort();

    for (const file of jsonFiles) {
        const filePath = `${dir}/${file}`;

        try {
            const data = await readJsonFromVfs(kernel, filePath);

            results.push({ file, data });
        }
        catch (err) {
            printk(kernel, 'warn', `Failed to load ${filePath}: ${err}`);
        }
    }

    return results;
}

/**
 * Load schema definitions for a single app.
 */
async function loadAppSchema(
    kernel: Kernel,
    appDir: string,
    ops: SchemaOps,
): Promise<{ models: number; fields: number }> {
    let models = 0;
    let fields = 0;

    // Load models
    const modelFiles = await loadJsonFilesFromVfs(kernel, `${appDir}/models`);

    for (const { data } of modelFiles) {
        for await (const _ of ops.upsertAll('models', [data], { key: 'model_name' })) {
            // Drain generator
        }

        models++;
    }

    // Load fields
    const fieldFiles = await loadJsonFilesFromVfs(kernel, `${appDir}/fields`);

    for (const { data } of fieldFiles) {
        const normalizedData = normalizeFieldData(data as Record<string, unknown>);

        for await (const _ of ops.upsertAll('fields', [normalizedData], { key: ['model_name', 'field_name'] })) {
            // Drain generator
        }

        fields++;
    }

    return { models, fields };
}

/**
 * Load schemas from all /app directories.
 *
 * @param kernel - Kernel instance with VFS and EMS
 */
export async function loadAppSchemas(kernel: Kernel): Promise<void> {
    // Skip if no EMS available
    if (!kernel.ems) {
        printk(kernel, 'warn', 'No EMS available, skipping app schema loading');

        return;
    }

    // Check if /app exists
    try {
        await kernel.vfs.stat('/app', 'kernel');
    }
    catch {
        // No /app directory - fine
        return;
    }

    const ops = kernel.ems.ops as unknown as SchemaOps;

    // Iterate over app directories
    for await (const entry of kernel.vfs.readdir('/app', 'kernel')) {
        if (entry.model !== 'folder') {
            continue;
        }

        const appName = entry.name;
        const appDir = `/app/${appName}`;

        // Check if app has models directory
        try {
            await kernel.vfs.stat(`${appDir}/models`, 'kernel');
        }
        catch {
            // No models directory - skip
            continue;
        }

        try {
            const { models, fields } = await loadAppSchema(kernel, appDir, ops);

            if (models > 0 || fields > 0) {
                printk(kernel, 'init', `Loaded schema for ${appName}: ${models} models, ${fields} fields`);
            }
        }
        catch (err) {
            printk(kernel, 'warn', `Failed to load schema for ${appName}: ${err}`);
        }
    }
}
