/**
 * update - Update an existing EMS record
 *
 * Usage:
 *   update <model> <id> <json>
 *   update <model> <id> field=value field=value ...
 *
 * Output: The updated record as JSON
 *
 * Examples:
 *   update ai.request abc123 '{"status":"ok"}'
 *   update ai.request abc123 status=ok result="done"
 *   update ai.stm xyz789 consolidated=1
 */

import {
    getargs,
    println,
    eprintln,
    exit,
    call,
} from '@rom/lib/process/index.js';

/**
 * Parse field=value arguments into an object.
 */
function parseFieldValues(args: string[]): Record<string, unknown> | null {
    if (!args.some(arg => arg.includes('='))) {
        return null;
    }

    const result: Record<string, unknown> = {};

    for (const arg of args) {
        const eqIndex = arg.indexOf('=');

        if (eqIndex === -1) {
            continue;
        }

        const key = arg.slice(0, eqIndex);
        let value: unknown = arg.slice(eqIndex + 1);

        // Try to parse value as JSON
        try {
            value = JSON.parse(value as string);
        }
        catch {
            // Keep as string - remove surrounding quotes if present
            const strValue = value as string;

            if ((strValue.startsWith('"') && strValue.endsWith('"')) ||
                (strValue.startsWith("'") && strValue.endsWith("'"))) {
                value = strValue.slice(1, -1);
            }
        }

        result[key] = value;
    }

    return Object.keys(result).length > 0 ? result : null;
}

async function main(): Promise<void> {
    const args = await getargs();

    if (args.length < 4) {
        await println('Usage: update <model> <id> <json | field=value ...>');
        await println('');
        await println('Examples:');
        await println('  update ai.request abc123 \'{"status":"ok"}\'');
        await println('  update ai.request abc123 status=ok result="done"');
        await println('  update ai.stm xyz789 consolidated=1');
        await exit(0);

        return;
    }

    const model = args[1];
    const id = args[2];
    const dataArgs = args.slice(3);

    let changes: Record<string, unknown>;

    // Try field=value syntax first
    const fieldValues = parseFieldValues(dataArgs);

    if (fieldValues) {
        changes = fieldValues;
    }
    else {
        // Try as JSON
        const jsonStr = dataArgs.join(' ');

        try {
            changes = JSON.parse(jsonStr);
        }
        catch {
            await eprintln('update: invalid JSON or field=value syntax');
            await exit(1);

            return;
        }
    }

    try {
        const updated = await call<Record<string, unknown>>('ems:update', model, id, changes);

        await println(JSON.stringify(updated, null, 2));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`update: ${msg}`);
        await exit(1);
    }
}

main().catch(async err => {
    await eprintln(`update: ${err.message}`);
    await exit(1);
});
