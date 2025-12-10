/**
 * select - Query EMS records
 *
 * Usage:
 *   select <model>                          List all records
 *   select <model> limit <n>                Limit results
 *   select <model> where <field>=<value>    Filter by field
 *   select <model> where <f1>=<v1> <f2>=<v2> limit <n>
 *
 * Output: JSON array of records
 *
 * Examples:
 *   select ai.request                       # All requests
 *   select ai.request limit 5               # Last 5 requests
 *   select ai.request where status=ok       # Successful requests
 *   select ai.stm where consolidated=0 limit 10
 */

import {
    getargs,
    println,
    eprintln,
    exit,
    collect,
} from '@rom/lib/process/index.js';

interface ParsedFilter {
    where?: Record<string, unknown>;
    limit?: number;
    orderBy?: string[];
}

/**
 * Parse command line arguments into filter object.
 *
 * Syntax: <model> [where field=value ...] [limit N] [order field]
 */
function parseArgs(args: string[]): { model: string; filter: ParsedFilter } {
    if (args.length < 2) {
        throw new Error('model name required');
    }

    const model = args[1]!;
    const filter: ParsedFilter = {};
    let i = 2;

    while (i < args.length) {
        const token = args[i]!.toLowerCase();

        if (token === 'limit') {
            i++;
            if (i >= args.length) {
                throw new Error('expected number after limit');
            }

            filter.limit = parseInt(args[i]!, 10);
            if (isNaN(filter.limit)) {
                throw new Error('limit must be a number');
            }

            i++;
        }
        else if (token === 'where') {
            i++;
            // Parse field=value pairs until we hit another keyword or end
            while (i < args.length) {
                const pair = args[i]!;

                if (['limit', 'order'].includes(pair.toLowerCase())) {
                    break;
                }

                if (pair.includes('=')) {
                    const eqIdx = pair.indexOf('=');
                    const field = pair.slice(0, eqIdx);
                    const value = parseValue(pair.slice(eqIdx + 1));

                    if (!filter.where) {
                        filter.where = {};
                    }

                    filter.where[field] = value;
                }

                i++;
            }
        }
        else if (token === 'order') {
            i++;
            // Parse order fields
            if (!filter.orderBy) {
                filter.orderBy = [];
            }

            while (i < args.length && !['limit', 'where'].includes(args[i]!.toLowerCase())) {
                filter.orderBy.push(args[i]!);
                i++;
            }
        }
        else if (args[i]!.includes('=')) {
            // Bare field=value (without 'where' keyword)
            const pair = args[i]!;
            const eqIdx = pair.indexOf('=');
            const field = pair.slice(0, eqIdx);
            const value = parseValue(pair.slice(eqIdx + 1));

            if (!filter.where) {
                filter.where = {};
            }

            filter.where[field] = value;
            i++;
        }
        else {
            i++;
        }
    }

    return { model, filter };
}

/**
 * Parse a value string into appropriate type.
 */
function parseValue(str: string): unknown {
    // Remove quotes if present
    if ((str.startsWith("'") && str.endsWith("'")) ||
        (str.startsWith('"') && str.endsWith('"'))) {
        return str.slice(1, -1);
    }

    // Try number
    const num = parseFloat(str);

    if (!isNaN(num) && String(num) === str) {
        return num;
    }

    // Try integer (handles "0", "1", etc.)
    const int = parseInt(str, 10);

    if (!isNaN(int) && String(int) === str) {
        return int;
    }

    // Booleans
    if (str.toLowerCase() === 'true') {
        return true;
    }

    if (str.toLowerCase() === 'false') {
        return false;
    }

    if (str.toLowerCase() === 'null') {
        return null;
    }

    // String
    return str;
}

async function main(): Promise<void> {
    const args = await getargs();

    if (args.length < 2) {
        await println('Usage: select <model> [where field=value ...] [limit N]');
        await println('');
        await println('Examples:');
        await println('  select ai.request');
        await println('  select ai.request limit 5');
        await println('  select ai.request where status=ok');
        await println('  select ai.stm where consolidated=0 limit 10');
        await exit(0);

        return;
    }

    try {
        const { model, filter } = parseArgs(args);

        // Build ems:select filter object
        const selectFilter: Record<string, unknown> = {};

        if (filter.where) {
            selectFilter.where = filter.where;
        }

        if (filter.limit) {
            selectFilter.limit = filter.limit;
        }

        if (filter.orderBy && filter.orderBy.length > 0) {
            selectFilter.orderBy = filter.orderBy;
        }

        // Query via ems:select syscall
        const records = await collect<Record<string, unknown>>(
            'ems:select',
            model,
            Object.keys(selectFilter).length > 0 ? selectFilter : undefined,
        );

        // Output as JSON
        await println(JSON.stringify(records, null, 2));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`select: ${msg}`);
        await exit(1);
    }
}

main().catch(async err => {
    await eprintln(`select: ${err.message}`);
    await exit(1);
});
