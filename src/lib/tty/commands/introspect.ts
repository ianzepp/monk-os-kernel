/**
 * introspect - Show summary of all models with fields and record counts
 *
 * Usage:
 *   introspect              Show all models
 *   introspect <model>      Show specific model
 *
 * Output:
 *   model_name (N records)
 *   - field_name: type
 *
 * Examples:
 *   introspect
 *   introspect users
 */

import { FSError } from '@src/lib/fs/index.js';
import type { CommandHandler } from './shared.js';

/** System fields to exclude from output */
const SYSTEM_FIELDS = new Set([
    'id',
    'access_read',
    'access_edit',
    'created_at',
    'updated_at',
    'deleted_at',
]);

interface FieldSchema {
    field_name: string;
    type: string;
    required?: boolean;
    related_model?: string | null;
}

interface ModelSchema {
    model_name: string;
    status?: string;
    description?: string | null;
    fields: FieldSchema[];
}

export const introspect: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('introspect: filesystem not available\n');
        return 1;
    }

    const specificModel = args[0];

    try {
        // Get list of models
        let modelNames: string[];

        if (specificModel) {
            modelNames = [specificModel];
        } else {
            const entries = await fs.readdir('/api/describe');
            modelNames = entries
                .filter(e => e.type === 'directory')
                .map(e => e.name)
                .sort();
        }

        if (modelNames.length === 0) {
            io.stdout.write('No models found\n');
            return 0;
        }

        const results: string[] = [];

        for (const modelName of modelNames) {
            try {
                // Get schema
                const schemaPath = `/api/describe/${modelName}/.json`;
                const schemaContent = await fs.read(schemaPath);
                const schema: ModelSchema = JSON.parse(schemaContent.toString());

                // Get record count
                let recordCount = 0;
                try {
                    const dataEntries = await fs.readdir(`/api/data/${modelName}`);
                    recordCount = dataEntries.filter(e => e.type === 'file').length;
                } catch {
                    // Model might not have data directory yet
                }

                // Filter out system fields
                const userFields = schema.fields.filter(f => !SYSTEM_FIELDS.has(f.field_name));

                // Format output
                results.push(formatModel(modelName, recordCount, schema.description, userFields));
            } catch (err) {
                if (err instanceof FSError && err.code === 'ENOENT') {
                    io.stderr.write(`introspect: ${modelName}: model not found\n`);
                } else {
                    throw err;
                }
            }
        }

        io.stdout.write(results.join('\n'));
        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            io.stderr.write(`introspect: ${err.message}\n`);
            return 1;
        }
        throw err;
    }
};

/**
 * Format a single model with its fields
 */
function formatModel(name: string, count: number, description: string | null | undefined, fields: FieldSchema[]): string {
    const lines: string[] = [];

    // Model header with count and description
    const countStr = count === 1 ? '1 record' : `${count} records`;
    if (description) {
        lines.push(`${name} (${countStr}, ${description})`);
    } else {
        lines.push(`${name} (${countStr})`);
    }

    // Fields
    if (fields.length === 0) {
        lines.push('  (no custom fields)');
    } else {
        for (const field of fields) {
            let typeStr = field.type;
            if (field.type === 'reference' && field.related_model) {
                typeStr = `reference(${field.related_model})`;
            }
            const reqStr = field.required ? '*' : '';
            lines.push(`  - ${field.field_name}${reqStr}: ${typeStr}`);
        }
    }

    lines.push('');
    return lines.join('\n');
}
