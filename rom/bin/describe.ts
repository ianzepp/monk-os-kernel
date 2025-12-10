/**
 * describe - Show EMS model schemas
 *
 * Usage:
 *   describe              Show all models (compact summary)
 *   describe <model>      Show detailed schema for one model
 *
 * Output format (no args - compact):
 *   model_name (field_count fields) - description
 *
 * Output format (with model - detailed):
 *   model_name (status)
 *   description
 *   Fields:
 *   - field_name (type, required?, unique?) "description"
 *
 * Examples:
 *   describe              # List all models
 *   describe ai.request   # Show ai.request schema
 *   describe file         # Show file model schema
 */

import {
    getargs,
    println,
    eprintln,
    exit,
    collect,
} from '@rom/lib/process/index.js';

interface FieldSchema {
    field_name: string;
    type: string;
    required: boolean;
    unique: boolean;
    description: string | null;
    related_model: string | null;
    enum_values: string[] | null;
}

interface ModelSchema {
    model_name: string;
    status: string;
    description: string | null;
    fields: FieldSchema[];
}

/**
 * Format a single field for detailed output
 */
function formatField(field: FieldSchema): string {
    const attrs: string[] = [field.type];

    if (field.related_model) {
        attrs[0] = `${field.type}(${field.related_model})`;
    }

    if (field.required) {
        attrs.push('required');
    }

    if (field.unique) {
        attrs.push('unique');
    }

    if (field.enum_values && field.enum_values.length > 0) {
        attrs.push(`enum[${field.enum_values.length}]`);
    }

    let line = `  - ${field.field_name} (${attrs.join(', ')})`;

    if (field.description) {
        line += ` "${field.description}"`;
    }

    return line;
}

/**
 * Format detailed output for a single model
 */
function formatDetailed(model: ModelSchema): string {
    const lines: string[] = [];

    // Header
    lines.push(`${model.model_name} (${model.status})`);

    if (model.description) {
        lines.push(model.description);
    }

    lines.push('');
    lines.push('Fields:');

    for (const field of model.fields) {
        lines.push(formatField(field));
    }

    return lines.join('\n');
}

/**
 * Format compact output for model listing
 */
function formatCompact(model: ModelSchema): string {
    const fieldCount = model.fields.length;
    const desc = model.description ? ` - ${model.description}` : '';

    return `${model.model_name} (${fieldCount} fields)${desc}`;
}

async function main(): Promise<void> {
    const args = await getargs();
    const modelArg = args[1]; // args[0] is 'describe'

    try {
        // Call ems:describe syscall (streams items, collect gathers them)
        const models = await collect<ModelSchema>('ems:describe', modelArg);

        if (models.length === 0) {
            if (modelArg) {
                await eprintln(`describe: model not found: ${modelArg}`);
                await exit(1);
            }
            else {
                await println('No models found.');
            }

            return;
        }

        // Single model = detailed output
        if (modelArg) {
            await println(formatDetailed(models[0]));
        }
        // All models = compact listing
        else {
            for (const model of models) {
                await println(formatCompact(model));
            }
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`describe: ${msg}`);
        await exit(1);
    }
}

main().catch(async err => {
    await eprintln(`describe: ${err.message}`);
    await exit(1);
});
