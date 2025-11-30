/**
 * update - Update a single record
 *
 * Usage:
 *   update <model> <id> [field=value ...]
 *   update <model> <id> '<json>'
 *   echo '<json>' | update <model> <id>
 *   update . [field=value ...]          (use current record)
 *
 * Examples:
 *   update users abc-123 status=active name="John Doe"
 *   update users abc-123 '{"status":"active"}'
 *   echo '{"status":"active"}' | update users abc-123
 *   update . status=active              (when in /api/data/users/abc-123)
 *
 * For bulk updates, use update_bulk instead.
 *
 * Outputs the updated record as JSON.
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
 * Resolve model and id from arguments and cwd
 * Returns { model, id, recordPath } or null if invalid
 */
function resolveRecord(args: string[], cwd: string): { model: string; id: string; recordPath: string; remainingArgs: string[] } | null {
    if (args.length === 0) return null;

    if (args[0] === '.') {
        // Use current directory - must be a record (/api/data/<model>/<id>)
        const match = cwd.match(/^\/api\/data\/([^/]+)\/([^/]+)\/?$/);
        if (!match) return null;
        return {
            model: match[1],
            id: match[2],
            recordPath: `/api/data/${match[1]}/${match[2]}`,
            remainingArgs: args.slice(1)
        };
    }

    // Need at least model and id
    if (args.length < 2) return null;

    const model = args[0].replace(/^\/api\/data\//, '').replace(/\/$/, '');
    if (!model || model.includes('/')) return null;

    const id = args[1];
    if (!id || id.includes('/')) return null;

    return {
        model,
        id,
        recordPath: `/api/data/${model}/${id}`,
        remainingArgs: args.slice(2)
    };
}

export const update: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('update: filesystem not available\n');
        return 1;
    }

    if (args.length === 0) {
        io.stderr.write('update: missing model and id\n');
        io.stderr.write('Usage: update <model> <id> [field=value ...]\n');
        return 1;
    }

    const resolved = resolveRecord(args, session.cwd);

    if (!resolved) {
        if (args[0] === '.') {
            io.stderr.write('update: not in a record directory\n');
            io.stderr.write('Use: cd /api/data/<model>/<id> first, or specify model and id\n');
        } else if (args.length < 2) {
            io.stderr.write('update: missing id\n');
            io.stderr.write('Usage: update <model> <id> [field=value ...]\n');
        } else {
            io.stderr.write(`update: invalid model or id\n`);
        }
        return 1;
    }

    const { model, id, recordPath, remainingArgs } = resolved;

    // Get data from args or stdin
    let changes: any;

    if (remainingArgs.length > 0) {
        // Try field=value syntax first
        const fieldValues = parseFieldValues(remainingArgs);
        if (fieldValues) {
            changes = fieldValues;
        } else {
            // Try as JSON
            const jsonStr = remainingArgs.join(' ');
            try {
                changes = JSON.parse(jsonStr);
            } catch {
                io.stderr.write('update: invalid JSON\n');
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
            io.stderr.write('update: no data provided\n');
            return 1;
        }

        try {
            changes = JSON.parse(jsonStr);
        } catch {
            io.stderr.write('update: invalid JSON\n');
            return 1;
        }
    }

    try {
        // Verify path is a file (record)
        const stat = await fs.stat(recordPath);
        if (stat.type !== 'file') {
            io.stderr.write(`update: ${model}/${id}: not a record\n`);
            return 1;
        }

        // Read existing record
        const existing = await fs.read(recordPath);
        const record = JSON.parse(existing.toString());

        // Merge changes (shallow merge, changes override existing)
        const updated = { ...record, ...changes };

        // Write back
        await fs.write(recordPath, JSON.stringify(updated));

        // Read back to get the full record
        const result = await fs.read(recordPath);
        io.stdout.write(result.toString() + '\n');

        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            if (err.code === 'ENOENT') {
                io.stderr.write(`update: ${model}/${id}: not found\n`);
            } else {
                io.stderr.write(`update: ${model}/${id}: ${err.message}\n`);
            }
            return 1;
        }
        throw err;
    }
};
