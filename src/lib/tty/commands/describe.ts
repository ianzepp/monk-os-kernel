/**
 * describe - Show model schema (compact format)
 *
 * Usage:
 *   describe <model>
 *   describe              (infer from CWD if in /api/data/<model>)
 *
 * Output format:
 *   model_name (status, description)
 *   - field_name (type, required?, unique?) "description"
 *
 * Examples:
 *   describe products
 *   describe users
 *   cd /api/data/orders && describe
 */

import { FSError } from '@src/lib/fs/index.js';
import type { CommandHandler } from './shared.js';

interface FieldSchema {
    field_name: string;
    type: string;
    required?: boolean;
    unique?: boolean;
    description?: string | null;
    related_model?: string | null;
    relationship_type?: string | null;
}

interface ModelSchema {
    model_name: string;
    status?: string;
    description?: string | null;
    fields: FieldSchema[];
}

export const describe: CommandHandler = async (session, fs, args, io) => {
    // If no model specified, try to infer from CWD
    const modelName = args[0] || inferModelFromCwd(session.cwd);

    if (!modelName) {
        io.stdout.write('Usage: describe <model>\n');
        io.stdout.write('  describe products\n');
        io.stdout.write('  describe users\n');
        return 0;
    }

    const schemaPath = `/api/describe/${modelName}/.json`;

    try {
        const content = await fs!.read(schemaPath);
        const schema: ModelSchema = JSON.parse(content.toString());
        io.stdout.write(formatSchema(schema));
        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            if (err.code === 'ENOENT') {
                io.stderr.write(`describe: ${modelName}: model not found\n`);
            } else {
                io.stderr.write(`describe: ${modelName}: ${err.message}\n`);
            }
            return 1;
        }
        throw err;
    }
};

/**
 * Format schema in compact readable format
 */
function formatSchema(schema: ModelSchema): string {
    const lines: string[] = [];

    // Model header: model_name (status, description)
    const modelParts: string[] = [];
    if (schema.status) {
        modelParts.push(schema.status);
    }
    if (schema.description) {
        modelParts.push(schema.description);
    }

    if (modelParts.length > 0) {
        lines.push(`${schema.model_name} (${modelParts.join(', ')})`);
    } else {
        lines.push(schema.model_name);
    }

    // Fields
    for (const field of schema.fields) {
        lines.push(formatField(field));
    }

    lines.push('');
    return lines.join('\n');
}

/**
 * Format a single field line
 */
function formatField(field: FieldSchema): string {
    const attrs: string[] = [field.type];

    // Add relationship target for reference fields
    if (field.type === 'reference' && field.related_model) {
        attrs[0] = `reference(${field.related_model})`;
    }

    if (field.required) {
        attrs.push('required');
    }
    if (field.unique) {
        attrs.push('unique');
    }

    let line = `- ${field.field_name} (${attrs.join(', ')})`;

    if (field.description) {
        line += ` "${field.description}"`;
    }

    return line;
}

/**
 * Try to infer model name from current working directory
 *
 * Works for paths like:
 *   /api/data/products      → products
 *   /api/data/products/123  → products
 *   /api/trashed/orders     → orders
 */
function inferModelFromCwd(cwd: string): string | null {
    const patterns = [
        /^\/api\/data\/([^/]+)/,
        /^\/api\/trashed\/([^/]+)/,
        /^\/api\/find\/([^/]+)/,
        /^\/api\/describe\/([^/]+)/,
    ];

    for (const pattern of patterns) {
        const match = cwd.match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}
