/**
 * create - Create a new EMS record
 *
 * Usage:
 *   create <model> <json>
 *   create <model> field=value field=value ...
 *
 * Output: The created record as JSON
 *
 * Examples:
 *   create ai.stm '{"content":"hello","salience":5}'
 *   create ai.stm content="hello world" salience=5
 *   create ai.ltm content="User prefers dark mode" category=user_prefs
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
        if (eqIndex === -1) continue;

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

    if (args.length < 3) {
        await println('Usage: create <model> <json | field=value ...>');
        await println('');
        await println('Examples:');
        await println('  create ai.stm \'{"content":"hello","salience":5}\'');
        await println('  create ai.stm content="hello world" salience=5');
        await println('  create ai.ltm content="User prefers dark mode" category=user_prefs');
        await exit(0);
        return;
    }

    const model = args[1];
    const dataArgs = args.slice(2);

    let fields: Record<string, unknown>;

    // Try field=value syntax first
    const fieldValues = parseFieldValues(dataArgs);
    if (fieldValues) {
        fields = fieldValues;
    }
    else {
        // Try as JSON
        const jsonStr = dataArgs.join(' ');
        try {
            fields = JSON.parse(jsonStr);
        }
        catch {
            await eprintln('create: invalid JSON or field=value syntax');
            await exit(1);
            return;
        }
    }

    try {
        const created = await call<Record<string, unknown>>('ems:create', model, fields);
        await println(JSON.stringify(created, null, 2));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`create: ${msg}`);
        await exit(1);
    }
}

main().catch(async err => {
    await eprintln(`create: ${err.message}`);
    await exit(1);
});
