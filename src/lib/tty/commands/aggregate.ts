/**
 * aggregate - Database aggregation command
 *
 * Usage:
 *   aggregate <model> <function>(<field>)... [where <conditions>] [group by <columns>]
 *
 * Output: JSON array (pipe to `format markdown` for tables)
 *
 * Examples:
 *   aggregate tasks count(*)
 *   aggregate tasks count(*) where status = 'active'
 *   aggregate tasks count(*) sum(estimate) avg(estimate)
 *   aggregate tasks count(*) sum(estimate) group by status
 *   aggregate tasks min(created_at) max(created_at) group by status
 *   aggregate tasks count(*) group by status, priority
 *
 * Aggregate functions:
 *   count(*), count(field), sum(field), avg(field), min(field), max(field), distinct(field)
 *
 * Where operators:
 *   =, !=, <>, <, >, <=, >=, like, in (...)
 */

import type { CommandHandler } from './shared.js';
import type { CommandIO } from '../types.js';
import { getHonoApp } from '@src/lib/internal-api.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';

interface AggregateSpec {
    alias: string;
    fn: '$count' | '$sum' | '$avg' | '$min' | '$max' | '$distinct';
    field: string;
}

interface ParsedAggregate {
    model: string;
    aggregates: AggregateSpec[];
    where?: any;
    groupBy?: string[];
}

export const aggregate: CommandHandler = async (session, _fs, args, io) => {
    if (args.length === 0) {
        printUsage(io);
        return 1;
    }

    try {
        const parsed = parseAggregateQuery(args);
        const result = await executeAggregate(session, parsed);
        io.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return 0;
    } catch (err) {
        io.stderr.write(`aggregate: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
};

/**
 * Parse aggregate command arguments
 */
function parseAggregateQuery(args: string[]): ParsedAggregate {
    let pos = 0;

    // First arg is the model
    const model = args[pos++];
    if (!model) {
        throw new Error('Model name required');
    }

    const aggregates: AggregateSpec[] = [];

    // Parse aggregate functions until we hit 'where' or 'group'
    while (pos < args.length) {
        const token = args[pos];
        const lower = token.toLowerCase();

        if (lower === 'where' || lower === 'group') {
            break;
        }

        const aggMatch = token.match(/^(count|sum|avg|min|max|distinct)\(([^)]+)\)$/i);
        if (!aggMatch) {
            throw new Error(`Invalid aggregate function: ${token}`);
        }

        const fnName = aggMatch[1].toLowerCase();
        const field = aggMatch[2].trim();
        const fn = ('$' + fnName) as '$count' | '$sum' | '$avg' | '$min' | '$max' | '$distinct';

        // Create alias from function name (add index if duplicate)
        let alias = fnName;
        const existingCount = aggregates.filter(a => a.alias.startsWith(fnName)).length;
        if (existingCount > 0 || field !== '*') {
            alias = field === '*' ? fnName : `${fnName}_${field}`;
        }

        aggregates.push({ alias, fn, field });
        pos++;
    }

    if (aggregates.length === 0) {
        throw new Error('At least one aggregate function required');
    }

    const result: ParsedAggregate = { model, aggregates };

    // Parse optional clauses
    while (pos < args.length) {
        const keyword = args[pos].toLowerCase();

        if (keyword === 'where') {
            pos++;
            const whereResult = parseWhere(args, pos);
            result.where = whereResult.where;
            pos = whereResult.nextPos;
        } else if (keyword === 'group') {
            if (args[pos + 1]?.toLowerCase() !== 'by') {
                throw new Error('Expected BY after GROUP');
            }
            pos += 2;
            const groupResult = parseGroupBy(args, pos);
            result.groupBy = groupResult.columns;
            pos = groupResult.nextPos;
        } else {
            throw new Error(`Unexpected keyword: ${args[pos]}`);
        }
    }

    return result;
}

/**
 * Parse WHERE clause
 */
function parseWhere(args: string[], pos: number): { where: any; nextPos: number } {
    const conditions: any[] = [];

    while (pos < args.length) {
        const keyword = args[pos]?.toLowerCase();
        if (['group'].includes(keyword)) {
            break;
        }

        // Parse condition: field op value
        const field = args[pos++];
        if (pos >= args.length) break;

        let op = args[pos++];
        if (pos >= args.length) {
            throw new Error('Expected value after operator in WHERE clause');
        }

        // Handle multi-token operators
        if (op.toLowerCase() === 'not' && args[pos]?.toLowerCase() === 'in') {
            op = 'not in';
            pos++;
        } else if (op.toLowerCase() === 'is' && args[pos]?.toLowerCase() === 'null') {
            op = 'is null';
            pos++;
        } else if (op.toLowerCase() === 'is' && args[pos]?.toLowerCase() === 'not') {
            if (args[pos + 1]?.toLowerCase() === 'null') {
                op = 'is not null';
                pos += 2;
            }
        }

        let condition: any;

        // Handle IS NULL / IS NOT NULL (no value needed)
        if (op === 'is null') {
            condition = { [field]: { $null: true } };
        } else if (op === 'is not null') {
            condition = { [field]: { $exists: true } };
        } else {
            const value = parseValue(args[pos++]);
            condition = convertCondition(field, op, value);
        }

        conditions.push(condition);

        // Check for AND/OR
        if (args[pos]?.toLowerCase() === 'and') {
            pos++;
        } else if (args[pos]?.toLowerCase() === 'or') {
            pos++;
        }
    }

    const where = conditions.length === 1
        ? conditions[0]
        : { $and: conditions };

    return { where, nextPos: pos };
}

/**
 * Convert SQL condition to filter format
 */
function convertCondition(field: string, op: string, value: any): any {
    switch (op.toLowerCase()) {
        case '=':
        case '==':
            return { [field]: value };
        case '!=':
        case '<>':
            return { [field]: { $ne: value } };
        case '>':
            return { [field]: { $gt: value } };
        case '>=':
            return { [field]: { $gte: value } };
        case '<':
            return { [field]: { $lt: value } };
        case '<=':
            return { [field]: { $lte: value } };
        case 'like':
            return { [field]: { $like: value } };
        case 'ilike':
            return { [field]: { $ilike: value } };
        case 'in':
        case 'not in':
            const inValues = parseInList(value);
            if (op.toLowerCase() === 'in') {
                return { [field]: { $in: inValues } };
            } else {
                return { [field]: { $nin: inValues } };
            }
        default:
            throw new Error(`Unknown operator: ${op}`);
    }
}

/**
 * Parse IN list: (val1, val2, val3)
 */
function parseInList(value: string): any[] {
    if (!value.startsWith('(') || !value.endsWith(')')) {
        throw new Error('IN clause requires parenthesized list');
    }

    const inner = value.slice(1, -1);
    return inner.split(',').map(v => parseValue(v.trim()));
}

/**
 * Parse a value (string, number, etc.)
 */
function parseValue(token: string): any {
    // Quoted string
    if ((token.startsWith("'") && token.endsWith("'")) ||
        (token.startsWith('"') && token.endsWith('"'))) {
        return token.slice(1, -1);
    }

    // Number
    const num = parseFloat(token);
    if (!isNaN(num)) {
        return num;
    }

    // Boolean
    if (token.toLowerCase() === 'true') return true;
    if (token.toLowerCase() === 'false') return false;
    if (token.toLowerCase() === 'null') return null;

    // Raw identifier (treat as string)
    return token;
}

/**
 * Parse GROUP BY clause
 */
function parseGroupBy(args: string[], pos: number): { columns: string[]; nextPos: number } {
    const columns: string[] = [];

    while (pos < args.length) {
        const token = args[pos];

        // Skip commas
        if (token === ',') {
            pos++;
            continue;
        }

        // Handle comma-separated values like "status,priority"
        if (token.includes(',')) {
            const parts = token.split(',').map(p => p.trim()).filter(p => p);
            columns.push(...parts);
            pos++;
            continue;
        }

        columns.push(token);
        pos++;
    }

    return { columns, nextPos: pos };
}

/**
 * Execute the aggregate query via internal API
 */
async function executeAggregate(session: any, parsed: ParsedAggregate): Promise<any[]> {
    const app = getHonoApp();
    if (!app) {
        throw new Error('Internal API not available');
    }

    const token = await JWTGenerator.fromSystemInit(session.systemInit!);

    // Build aggregate body
    const aggregate: Record<string, any> = {};
    for (const agg of parsed.aggregates) {
        aggregate[agg.alias] = { [agg.fn]: agg.field };
    }

    const body: any = {
        aggregate,
    };

    if (parsed.where) {
        body.where = parsed.where;
    }

    if (parsed.groupBy && parsed.groupBy.length > 0) {
        body.groupBy = parsed.groupBy;
    }

    const endpoint = `/api/aggregate/${parsed.model}`;
    const response = await app.fetch(new Request(`http://localhost${endpoint}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    }));

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API error: ${response.status} ${text}`);
    }

    const result = await response.json() as { data?: any[] } | any[];

    // Handle wrapped response
    let rows = (result as any).data ?? result;
    if (!Array.isArray(rows)) {
        rows = [rows];
    }

    return rows;
}

/**
 * Print usage information
 */
function printUsage(io: CommandIO): void {
    io.stdout.write('Usage: aggregate <model> <function>(<field>)... [where ...] [group by ...]\n');
    io.stdout.write('\n');
    io.stdout.write('Examples:\n');
    io.stdout.write('  aggregate tasks count(*)\n');
    io.stdout.write('  aggregate tasks count(*) where status = \'active\'\n');
    io.stdout.write('  aggregate tasks count(*) sum(estimate) avg(estimate)\n');
    io.stdout.write('  aggregate tasks count(*) group by status\n');
    io.stdout.write('  aggregate tasks count(*) sum(estimate) group by status, priority\n');
    io.stdout.write('\n');
    io.stdout.write('Functions: count(*), count(field), sum(field), avg(field), min(field), max(field), distinct(field)\n');
}
