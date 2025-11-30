/**
 * insert - Create a single record
 *
 * Usage:
 *   insert <model> [field=value ...]
 *   insert <model> '<json>'
 *   echo '<json>' | insert <model>
 *   insert . [field=value ...]          (use current collection)
 *
 * Examples:
 *   insert users name="John Doe" role=user
 *   insert users '{"name":"Bob","email":"bob@test.com"}'
 *   echo '{"name":"Bob"}' | insert users
 *   insert . name=Bob                   (when in /api/data/users)
 *
 * For bulk inserts, use insert_bulk instead.
 *
 * Outputs the created record as JSON.
 */

import { FSError } from '@src/lib/fs/index.js';
import type { CommandHandler } from './shared.js';

/**
 * Parse field=value arguments into an object
 */
function parseFieldValues(args: string[]): Record<string, any> | null {
    if (!args.some(arg => arg.includes('='))) {
        return null;
    }

    const result: Record<string, any> = {};

    for (const arg of args) {
        const eqIndex = arg.indexOf('=');
        if (eqIndex === -1) continue;

        const key = arg.slice(0, eqIndex);
        let value: any = arg.slice(eqIndex + 1);

        // Try to parse value as JSON
        try {
            value = JSON.parse(value);
        } catch {
            // Keep as string - remove surrounding quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
        }

        result[key] = value;
    }

    return Object.keys(result).length > 0 ? result : null;
}

/**
 * Resolve model from argument and cwd
 * Returns { model, collectionPath } or null if invalid
 */
function resolveModel(arg: string, cwd: string): { model: string; collectionPath: string } | null {
    if (arg === '.') {
        // Use current directory - must be a collection (/api/data/<model>)
        const match = cwd.match(/^\/api\/data\/([^/]+)\/?$/);
        if (!match) return null;
        return { model: match[1], collectionPath: `/api/data/${match[1]}` };
    }

    // Treat as model name directly
    const model = arg.replace(/^\/api\/data\//, '').replace(/\/$/, '');
    if (!model || model.includes('/')) return null;
    return { model, collectionPath: `/api/data/${model}` };
}

export const insert: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('insert: filesystem not available\n');
        return 1;
    }

    if (args.length === 0) {
        io.stderr.write('insert: missing model\n');
        io.stderr.write('Usage: insert <model> [field=value ...]\n');
        return 1;
    }

    const modelArg = args[0];
    const resolved = resolveModel(modelArg, session.cwd);

    if (!resolved) {
        if (modelArg === '.') {
            io.stderr.write('insert: not in a collection directory\n');
            io.stderr.write('Use: cd /api/data/<model> first, or specify model name\n');
        } else {
            io.stderr.write(`insert: invalid model: ${modelArg}\n`);
        }
        return 1;
    }

    const { model, collectionPath } = resolved;

    // Get data from args or stdin
    let data: any;

    if (args.length > 1) {
        // Try field=value syntax first
        const fieldValues = parseFieldValues(args.slice(1));
        if (fieldValues) {
            data = fieldValues;
        } else {
            // Try as JSON
            const jsonStr = args.slice(1).join(' ');
            try {
                data = JSON.parse(jsonStr);
            } catch {
                io.stderr.write('insert: invalid JSON\n');
                return 1;
            }
        }
    } else {
        // Read from stdin
        const chunks: string[] = [];
        for await (const chunk of io.stdin) {
            chunks.push(chunk.toString());
        }
        const jsonStr = chunks.join('');

        if (!jsonStr.trim()) {
            io.stderr.write('insert: no data provided\n');
            return 1;
        }

        try {
            data = JSON.parse(jsonStr);
        } catch {
            io.stderr.write('insert: invalid JSON\n');
            return 1;
        }
    }

    // Reject arrays - use insert_bulk for batch operations
    if (Array.isArray(data)) {
        io.stderr.write('insert: use insert_bulk for arrays\n');
        return 1;
    }

    // Validate data is an object
    if (typeof data !== 'object' || data === null) {
        io.stderr.write('insert: data must be a JSON object\n');
        return 1;
    }

    try {
        // Verify collection exists
        const stat = await fs.stat(collectionPath);
        if (stat.type !== 'directory') {
            io.stderr.write(`insert: ${model}: not a collection\n`);
            return 1;
        }

        // Generate ID if not provided
        const id = data.id || crypto.randomUUID();
        const recordPath = `${collectionPath}/${id}`;

        // Check if exists
        try {
            await fs.stat(recordPath);
            io.stderr.write(`insert: ${id}: already exists\n`);
            return 1;
        } catch (err) {
            if (!(err instanceof FSError && err.code === 'ENOENT')) {
                throw err;
            }
            // Good - doesn't exist
        }

        // Write the record
        await fs.write(recordPath, JSON.stringify({ ...data, id }));

        // Read back to get the full record with defaults
        const created = await fs.read(recordPath);
        const result = JSON.parse(created.toString());

        io.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            io.stderr.write(`insert: ${model}: ${err.message}\n`);
            return 1;
        }
        throw err;
    }
};
