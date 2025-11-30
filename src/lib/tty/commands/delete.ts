/**
 * delete - Delete a single record
 *
 * Usage:
 *   delete <model> <id>
 *   delete .                    (use current record)
 *
 * Examples:
 *   delete users abc-123
 *   delete .                    (when in /api/data/users/abc-123)
 *
 * For bulk deletes, use delete_bulk instead.
 *
 * Outputs the deleted record as JSON.
 */

import { FSError } from '@src/lib/fs/index.js';
import type { CommandHandler } from './shared.js';

/**
 * Resolve model and id from arguments and cwd
 * Returns { model, id, recordPath } or null if invalid
 */
function resolveRecord(args: string[], cwd: string): { model: string; id: string; recordPath: string } | null {
    if (args.length === 0) return null;

    if (args[0] === '.') {
        // Use current directory - must be a record (/api/data/<model>/<id>)
        const match = cwd.match(/^\/api\/data\/([^/]+)\/([^/]+)\/?$/);
        if (!match) return null;
        return {
            model: match[1],
            id: match[2],
            recordPath: `/api/data/${match[1]}/${match[2]}`
        };
    }

    // Need model and id
    if (args.length < 2) return null;

    const model = args[0].replace(/^\/api\/data\//, '').replace(/\/$/, '');
    if (!model || model.includes('/')) return null;

    const id = args[1];
    if (!id || id.includes('/')) return null;

    return {
        model,
        id,
        recordPath: `/api/data/${model}/${id}`
    };
}

export const delete_: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('delete: filesystem not available\n');
        return 1;
    }

    if (args.length === 0) {
        io.stderr.write('delete: missing model and id\n');
        io.stderr.write('Usage: delete <model> <id>\n');
        return 1;
    }

    // Reject extra arguments
    if (args.length > 2 || (args[0] === '.' && args.length > 1)) {
        io.stderr.write('delete: too many arguments\n');
        io.stderr.write('Use delete_bulk for multiple records.\n');
        return 1;
    }

    const resolved = resolveRecord(args, session.cwd);

    if (!resolved) {
        if (args[0] === '.') {
            io.stderr.write('delete: not in a record directory\n');
            io.stderr.write('Use: cd /api/data/<model>/<id> first, or specify model and id\n');
        } else if (args.length < 2) {
            io.stderr.write('delete: missing id\n');
            io.stderr.write('Usage: delete <model> <id>\n');
        } else {
            io.stderr.write(`delete: invalid model or id\n`);
        }
        return 1;
    }

    const { model, id, recordPath } = resolved;

    try {
        const stat = await fs.stat(recordPath);
        if (stat.type === 'directory') {
            io.stderr.write(`delete: ${model}/${id}: is a collection\n`);
            io.stderr.write('Use delete_bulk to delete multiple records.\n');
            return 1;
        }

        // Read the record before deleting
        const content = await fs.read(recordPath);
        const record = JSON.parse(content.toString());

        // Delete the record
        await fs.unlink(recordPath);

        // Output deleted record
        io.stdout.write(JSON.stringify(record, null, 2) + '\n');
        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            if (err.code === 'ENOENT') {
                io.stderr.write(`delete: ${model}/${id}: not found\n`);
            } else {
                io.stderr.write(`delete: ${model}/${id}: ${err.message}\n`);
            }
            return 1;
        }
        throw err;
    }
};

// Export as 'delete' for command registry
export { delete_ as delete };
