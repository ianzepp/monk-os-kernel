/**
 * select - SQL-like query command
 *
 * Usage:
 *   select <columns> from <model> [where <conditions>] [group by <columns>] [order by <column> [asc|desc]] [limit N]
 *
 * Output: JSON array (pipe to `format markdown` for tables)
 *
 * Examples:
 *   select all from users                (use 'all' to avoid shell glob expansion)
 *   select id, name from users
 *   select id, name from users where status = 'active'
 *   select type, count(*) from fields group by type
 *   select all from users | format markdown
 *   select all from users | format csv > users.csv
 *
 * Aggregate functions:
 *   count(*), count(field), sum(field), avg(field), min(field), max(field)
 *
 * Where operators:
 *   =, !=, <>, <, >, <=, >=, like, in (...)
 */

import type { CommandHandler } from './shared.js';
import type { CommandIO } from '../types.js';
import { getHonoApp } from '@src/lib/internal-api.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';

interface ParsedQuery {
    columns: ColumnSpec[];
    model: string;
    where?: any;
    groupBy?: string[];
    orderBy?: { field: string; direction: 'asc' | 'desc' }[];
    limit?: number;
}

interface ColumnSpec {
    name: string;
    alias?: string;
    aggregate?: {
        fn: '$count' | '$sum' | '$avg' | '$min' | '$max';
        field: string;
    };
}

export const select: CommandHandler = async (session, _fs, args, io) => {
    if (args.length === 0) {
        printUsage(io);
        return 1;
    }

    // Join args and parse
    const query = args.join(' ');

    try {
        const parsed = parseSelectQuery(query);
        const result = await executeQuery(session, parsed);
        formatOutput(result, parsed, io);
        return 0;
    } catch (err) {
        io.stderr.write(`select: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
};

/**
 * Parse SQL-like select query
 */
function parseSelectQuery(query: string): ParsedQuery {
    // Normalize whitespace
    const normalized = query.replace(/\s+/g, ' ').trim();

    // Tokenize while preserving quoted strings and parentheses
    const tokens = tokenize(normalized);

    let pos = 0;

    // Parse columns (everything before FROM)
    const columns: ColumnSpec[] = [];
    while (pos < tokens.length && tokens[pos].toLowerCase() !== 'from') {
        const col = parseColumn(tokens, pos);
        columns.push(col.spec);
        pos = col.nextPos;

        // Skip comma
        if (tokens[pos] === ',') {
            pos++;
        }
    }

    if (columns.length === 0) {
        throw new Error('No columns specified');
    }

    // Expect FROM
    if (tokens[pos]?.toLowerCase() !== 'from') {
        throw new Error('Expected FROM clause');
    }
    pos++;

    // Parse model name
    if (pos >= tokens.length) {
        throw new Error('Expected model name after FROM');
    }
    const model = tokens[pos++];

    const result: ParsedQuery = { columns, model };

    // Parse optional clauses
    while (pos < tokens.length) {
        const keyword = tokens[pos].toLowerCase();

        if (keyword === 'where') {
            pos++;
            const whereResult = parseWhere(tokens, pos);
            result.where = whereResult.where;
            pos = whereResult.nextPos;
        } else if (keyword === 'group') {
            if (tokens[pos + 1]?.toLowerCase() !== 'by') {
                throw new Error('Expected BY after GROUP');
            }
            pos += 2;
            const groupResult = parseGroupBy(tokens, pos);
            result.groupBy = groupResult.columns;
            pos = groupResult.nextPos;
        } else if (keyword === 'order') {
            if (tokens[pos + 1]?.toLowerCase() !== 'by') {
                throw new Error('Expected BY after ORDER');
            }
            pos += 2;
            const orderResult = parseOrderBy(tokens, pos);
            result.orderBy = orderResult.orders;
            pos = orderResult.nextPos;
        } else if (keyword === 'limit') {
            pos++;
            if (pos >= tokens.length) {
                throw new Error('Expected number after LIMIT');
            }
            result.limit = parseInt(tokens[pos++], 10);
            if (isNaN(result.limit)) {
                throw new Error('LIMIT must be a number');
            }
        } else {
            throw new Error(`Unexpected keyword: ${tokens[pos]}`);
        }
    }

    return result;
}

/**
 * Tokenize SQL query preserving strings and parentheses
 */
function tokenize(query: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    let parenDepth = 0;

    for (let i = 0; i < query.length; i++) {
        const char = query[i];

        if (inQuote) {
            current += char;
            if (char === inQuote) {
                // Check for escaped quote
                if (i + 1 < query.length && query[i + 1] === inQuote) {
                    current += query[++i];
                } else {
                    inQuote = null;
                }
            }
        } else if (char === "'" || char === '"') {
            current += char;
            inQuote = char;
        } else if (char === '(') {
            if (parenDepth === 0 && current.trim()) {
                // Function name before paren
                current += char;
            } else {
                current += char;
            }
            parenDepth++;
        } else if (char === ')') {
            current += char;
            parenDepth--;
        } else if (parenDepth > 0) {
            current += char;
        } else if (char === ',' || char === ' ') {
            if (current.trim()) {
                tokens.push(current.trim());
            }
            if (char === ',') {
                tokens.push(',');
            }
            current = '';
        } else {
            current += char;
        }
    }

    if (current.trim()) {
        tokens.push(current.trim());
    }

    return tokens;
}

/**
 * Parse a column specification
 */
function parseColumn(tokens: string[], pos: number): { spec: ColumnSpec; nextPos: number } {
    let token = tokens[pos];

    // Handle 'all' as alias for '*' (avoids shell glob expansion)
    if (token.toLowerCase() === 'all') {
        token = '*';
    }

    // Check for aggregate function: count(*), sum(field), etc.
    const aggMatch = token.match(/^(count|sum|avg|min|max)\(([^)]+)\)$/i);
    if (aggMatch) {
        const fn = ('$' + aggMatch[1].toLowerCase()) as '$count' | '$sum' | '$avg' | '$min' | '$max';
        const field = aggMatch[2].trim();
        return {
            spec: {
                name: aggMatch[1].toLowerCase(),
                aggregate: { fn, field },
            },
            nextPos: pos + 1,
        };
    }

    // Regular column or *
    return {
        spec: { name: token },
        nextPos: pos + 1,
    };
}

/**
 * Parse WHERE clause
 */
function parseWhere(tokens: string[], pos: number): { where: any; nextPos: number } {
    const conditions: any[] = [];

    while (pos < tokens.length) {
        const keyword = tokens[pos]?.toLowerCase();
        if (['group', 'order', 'limit'].includes(keyword)) {
            break;
        }

        // Parse condition: field op value
        const field = tokens[pos++];
        if (pos >= tokens.length) break;

        let op = tokens[pos++];
        if (pos >= tokens.length) {
            throw new Error(`Expected value after operator in WHERE clause`);
        }

        // Handle multi-token operators
        if (op.toLowerCase() === 'not' && tokens[pos]?.toLowerCase() === 'in') {
            op = 'not in';
            pos++;
        } else if (op.toLowerCase() === 'is' && tokens[pos]?.toLowerCase() === 'null') {
            op = 'is null';
            pos++;
        } else if (op.toLowerCase() === 'is' && tokens[pos]?.toLowerCase() === 'not') {
            if (tokens[pos + 1]?.toLowerCase() === 'null') {
                op = 'is not null';
                pos += 2;
            }
        }

        let value: any;
        let condition: any;

        // Handle IS NULL / IS NOT NULL (no value needed)
        if (op === 'is null') {
            condition = { [field]: { $null: true } };
        } else if (op === 'is not null') {
            condition = { [field]: { $exists: true } };
        } else {
            value = parseValue(tokens[pos++]);

            // Convert SQL operator to filter operator
            condition = convertCondition(field, op, value);
        }

        conditions.push(condition);

        // Check for AND/OR
        if (tokens[pos]?.toLowerCase() === 'and') {
            pos++;
        } else if (tokens[pos]?.toLowerCase() === 'or') {
            pos++;
            // For simplicity, treat OR by wrapping in $or
            // This is a simplification - real SQL parsing would be more complex
        }
    }

    // Merge conditions
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
            // Parse IN list: (val1, val2, val3)
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
function parseGroupBy(tokens: string[], pos: number): { columns: string[]; nextPos: number } {
    const columns: string[] = [];

    while (pos < tokens.length) {
        const keyword = tokens[pos]?.toLowerCase();
        if (['order', 'limit', 'having'].includes(keyword)) {
            break;
        }

        if (tokens[pos] === ',') {
            pos++;
            continue;
        }

        columns.push(tokens[pos++]);
    }

    return { columns, nextPos: pos };
}

/**
 * Parse ORDER BY clause
 */
function parseOrderBy(tokens: string[], pos: number): { orders: { field: string; direction: 'asc' | 'desc' }[]; nextPos: number } {
    const orders: { field: string; direction: 'asc' | 'desc' }[] = [];

    while (pos < tokens.length) {
        const keyword = tokens[pos]?.toLowerCase();
        if (['limit'].includes(keyword)) {
            break;
        }

        if (tokens[pos] === ',') {
            pos++;
            continue;
        }

        const field = tokens[pos++];
        let direction: 'asc' | 'desc' = 'asc';

        if (pos < tokens.length) {
            const dir = tokens[pos].toLowerCase();
            if (dir === 'asc' || dir === 'desc') {
                direction = dir;
                pos++;
            }
        }

        orders.push({ field, direction });
    }

    return { orders, nextPos: pos };
}

/**
 * Execute the parsed query via internal API
 */
async function executeQuery(session: any, parsed: ParsedQuery): Promise<any[]> {
    const app = getHonoApp();
    if (!app) {
        throw new Error('Internal API not available');
    }

    const token = await JWTGenerator.fromSystemInit(session.systemInit!);

    // Determine if this is an aggregate query
    const hasAggregates = parsed.columns.some(c => c.aggregate);

    let endpoint: string;
    let body: any;

    if (hasAggregates) {
        // Use aggregate endpoint
        endpoint = `/api/aggregate/${parsed.model}`;

        const aggregate: Record<string, any> = {};
        const selectFields: string[] = [];

        for (const col of parsed.columns) {
            if (col.aggregate) {
                aggregate[col.name] = { [col.aggregate.fn]: col.aggregate.field };
            } else if (col.name !== '*') {
                selectFields.push(col.name);
            }
        }

        body = {
            aggregate,
            where: parsed.where,
            groupBy: parsed.groupBy,
        };
    } else {
        // Use find endpoint for regular selects
        endpoint = `/api/find/${parsed.model}`;

        const selectFields = parsed.columns[0]?.name === '*'
            ? undefined
            : parsed.columns.map(c => c.name);

        body = {
            select: selectFields,
            where: parsed.where,
            limit: parsed.limit,
        };

        if (parsed.orderBy && parsed.orderBy.length > 0) {
            body.order = parsed.orderBy.reduce((acc, o) => {
                acc[o.field] = o.direction;
                return acc;
            }, {} as Record<string, string>);
        }
    }

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

    // Apply ORDER BY for aggregate results (API might not support it)
    if (hasAggregates && parsed.orderBy && parsed.orderBy.length > 0) {
        rows = sortRows(rows, parsed.orderBy);
    }

    // Apply LIMIT for aggregate results
    if (hasAggregates && parsed.limit) {
        rows = rows.slice(0, parsed.limit);
    }

    return rows;
}

/**
 * Sort rows by order specification
 */
function sortRows(rows: any[], orderBy: { field: string; direction: 'asc' | 'desc' }[]): any[] {
    return [...rows].sort((a, b) => {
        for (const { field, direction } of orderBy) {
            const aVal = a[field];
            const bVal = b[field];

            let cmp = 0;
            if (aVal < bVal) cmp = -1;
            else if (aVal > bVal) cmp = 1;

            if (cmp !== 0) {
                return direction === 'desc' ? -cmp : cmp;
            }
        }
        return 0;
    });
}

/**
 * Format and output results as JSON
 */
function formatOutput(rows: any[], parsed: ParsedQuery, io: CommandIO): void {
    // Filter columns if specific ones were requested
    let output = rows;
    if (parsed.columns[0]?.name !== '*') {
        const columns = parsed.columns.map(c => c.name);
        output = rows.map(row => {
            const filtered: Record<string, any> = {};
            for (const col of columns) {
                if (col in row) {
                    filtered[col] = row[col];
                }
            }
            return filtered;
        });
    }

    // Output as JSON array
    io.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

/**
 * Print usage information
 */
function printUsage(io: CommandIO): void {
    io.stdout.write('Usage: select <columns> from <model> [where ...] [group by ...] [order by ...] [limit N]\n');
    io.stdout.write('\n');
    io.stdout.write('Examples:\n');
    io.stdout.write('  select * from users\n');
    io.stdout.write('  select id, name from users\n');
    io.stdout.write('  select id, name from users where status = \'active\'\n');
    io.stdout.write('  select type, count(*) from fields group by type\n');
    io.stdout.write('  select type, count(*) from fields group by type order by count desc\n');
    io.stdout.write('\n');
    io.stdout.write('Aggregates: count(*), sum(field), avg(field), min(field), max(field)\n');
}
