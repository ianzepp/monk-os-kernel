/**
 * query - Query records with filters (AI-optimized output)
 *
 * Usage:
 *   query <model> [where <conditions>] [order <field> [asc|desc]] [limit <n>]
 *
 * Where conditions:
 *   field=value          Exact match
 *   field!=value         Not equal
 *   field>value          Greater than
 *   field>=value         Greater than or equal
 *   field<value          Less than
 *   field<=value         Less than or equal
 *   field~value          ILIKE pattern match
 *
 * Examples:
 *   query users
 *   query users limit 5
 *   query users where access=root
 *   query users where name~john order name limit 10
 *   query products where price>100 order price desc
 */

import type { CommandHandler } from './shared.js';
import { getHonoApp } from '@src/lib/internal-api.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';

interface WhereClause {
    [key: string]: any;
}

export const query: CommandHandler = async (session, _fs, args, io) => {
    if (args.length === 0) {
        io.stderr.write('Usage: query <model> [where <conditions>] [order <field> [asc|desc]] [limit <n>]\n');
        io.stderr.write('Examples:\n');
        io.stderr.write('  query users\n');
        io.stderr.write('  query users where access=root\n');
        io.stderr.write('  query products where price>100 order price desc limit 10\n');
        return 1;
    }

    const model = args[0];
    const parsed = parseArgs(args.slice(1));

    if (parsed.error) {
        io.stderr.write(`query: ${parsed.error}\n`);
        return 1;
    }

    // Build request body
    const body: Record<string, any> = {};

    if (Object.keys(parsed.where).length > 0) {
        body.where = parsed.where;
    }
    if (parsed.order.length > 0) {
        body.order = parsed.order;
    }
    if (parsed.limit !== null) {
        body.limit = parsed.limit;
    }

    // Determine endpoint - use POST /api/find for complex queries, GET /api/data for simple
    const useFind = Object.keys(body).length > 0 && (body.where || body.order);
    const endpoint = useFind ? `/api/find/${model}` : `/api/data/${model}`;
    const method = useFind ? 'POST' : 'GET';

    // Build URL with query params for simple GET
    let url = endpoint;
    if (!useFind && parsed.limit !== null) {
        url += `?limit=${parsed.limit}`;
    }

    // Add format params
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}unwrap&format=toon`;

    try {
        const app = getHonoApp();
        if (!app) {
            io.stderr.write('query: internal API not available\n');
            return 1;
        }

        const token = await JWTGenerator.fromSystemInit(session.systemInit!);

        const init: RequestInit = {
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        };

        if (method === 'POST') {
            init.body = JSON.stringify(body);
        }

        const request = new Request(`http://localhost${url}`, init);
        const response = await app.fetch(request);

        const text = await response.text();

        if (!response.ok) {
            io.stderr.write(`query: ${response.status} ${response.statusText}\n`);
            if (text) {
                io.stderr.write(text + '\n');
            }
            return 1;
        }

        io.stdout.write(text);
        if (text && !text.endsWith('\n')) {
            io.stdout.write('\n');
        }

        return 0;
    } catch (err) {
        io.stderr.write(`query: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
};

interface ParsedArgs {
    where: WhereClause;
    order: string[];
    limit: number | null;
    error?: string;
}

/**
 * Parse query arguments into structured form
 */
function parseArgs(args: string[]): ParsedArgs {
    const result: ParsedArgs = {
        where: {},
        order: [],
        limit: null,
    };

    let i = 0;
    while (i < args.length) {
        const arg = args[i].toLowerCase();

        if (arg === 'where') {
            i++;
            // Parse conditions until we hit 'order', 'limit', or end
            while (i < args.length && !['order', 'limit'].includes(args[i].toLowerCase())) {
                const condition = args[i];
                const parsed = parseCondition(condition);
                if (parsed.error) {
                    return { ...result, error: parsed.error };
                }
                if (parsed.field && parsed.op) {
                    result.where[parsed.field] = parsed.value;
                }
                i++;
            }
        } else if (arg === 'order') {
            i++;
            if (i >= args.length) {
                return { ...result, error: 'order requires a field name' };
            }
            const field = args[i];
            i++;
            // Check for asc/desc
            let direction = 'asc';
            if (i < args.length && ['asc', 'desc'].includes(args[i].toLowerCase())) {
                direction = args[i].toLowerCase();
                i++;
            }
            result.order.push(`${field} ${direction}`);
        } else if (arg === 'limit') {
            i++;
            if (i >= args.length) {
                return { ...result, error: 'limit requires a number' };
            }
            const n = parseInt(args[i], 10);
            if (isNaN(n) || n < 0) {
                return { ...result, error: `invalid limit: ${args[i]}` };
            }
            result.limit = n;
            i++;
        } else {
            // Unknown arg - might be a condition without 'where' keyword
            const parsed = parseCondition(args[i]);
            if (parsed.field && parsed.op) {
                result.where[parsed.field] = parsed.value;
            }
            i++;
        }
    }

    return result;
}

interface ParsedCondition {
    field?: string;
    op?: string;
    value?: any;
    error?: string;
}

/**
 * Parse a single condition like "name=john" or "price>100"
 */
function parseCondition(condition: string): ParsedCondition {
    // Order matters - check multi-char operators first
    const operators = [
        { op: '!=', mongoOp: '$ne' },
        { op: '>=', mongoOp: '$gte' },
        { op: '<=', mongoOp: '$lte' },
        { op: '>', mongoOp: '$gt' },
        { op: '<', mongoOp: '$lt' },
        { op: '~', mongoOp: '$ilike' },
        { op: '=', mongoOp: '$eq' },
    ];

    for (const { op, mongoOp } of operators) {
        const idx = condition.indexOf(op);
        if (idx > 0) {
            const field = condition.slice(0, idx);
            let value: any = condition.slice(idx + op.length);

            // Try to parse as number or boolean
            if (value === 'true') value = true;
            else if (value === 'false') value = false;
            else if (value === 'null') value = null;
            else if (/^-?\d+(\.\d+)?$/.test(value)) value = parseFloat(value);

            // For simple equality, just use the value directly
            if (mongoOp === '$eq') {
                return { field, op: mongoOp, value };
            }

            // For ilike, add wildcards if not present
            if (mongoOp === '$ilike' && typeof value === 'string') {
                if (!value.includes('%')) {
                    value = `%${value}%`;
                }
            }

            return { field, op: mongoOp, value: { [mongoOp]: value } };
        }
    }

    return {};
}
