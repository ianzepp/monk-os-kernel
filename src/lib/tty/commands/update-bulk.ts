/**
 * update_bulk - Bulk update records
 *
 * Usage:
 *   update_bulk <model> < data.json
 *   update_bulk <model> --file=data.json
 *   cat data.json | update_bulk <model>
 *
 * Input must be a JSON array of records with "id" fields.
 * Uses direct API call for efficient bulk updates.
 *
 * Options:
 *   --file=<path>   Read from file instead of stdin
 *   --dry-run       Validate without updating
 *
 * Examples:
 *   cat users.json | update_bulk users
 *   update_bulk products --file=products.json
 *   update_bulk orders --dry-run < orders.json
 */

import type { CommandHandler } from './shared.js';
import { resolvePath } from '../parser.js';
import { getHonoApp } from '@src/lib/internal-api.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';

export const update_bulk: CommandHandler = async (session, fs, args, io) => {
    if (args.length === 0) {
        io.stderr.write('update_bulk: missing model\n');
        io.stderr.write('Usage: update_bulk <model> [--file=<file>] [--dry-run] < data.json\n');
        return 1;
    }

    // Parse args
    let modelArg: string | null = null;
    let filePath: string | null = null;
    let dryRun = false;

    for (const arg of args) {
        if (arg.startsWith('--file=')) {
            filePath = arg.slice(7);
        } else if (arg === '--dry-run') {
            dryRun = true;
        } else if (!arg.startsWith('-')) {
            if (modelArg === null) {
                modelArg = arg;
            } else {
                io.stderr.write(`update_bulk: unexpected argument: ${arg}\n`);
                io.stderr.write('Note: update_bulk does not accept field=value pairs. Use update for single records.\n');
                return 1;
            }
        } else {
            io.stderr.write(`update_bulk: unknown option: ${arg}\n`);
            return 1;
        }
    }

    if (!modelArg) {
        io.stderr.write('update_bulk: missing model\n');
        return 1;
    }

    // Extract model name (strip /api/data/ prefix if present)
    const model = modelArg.replace(/^\/api\/data\//, '').replace(/\/$/, '');
    if (!model || model.includes('/')) {
        io.stderr.write(`update_bulk: invalid model: ${modelArg}\n`);
        return 1;
    }

    // Read JSON input
    let jsonStr: string;

    if (filePath) {
        // Read from file
        if (!fs) {
            io.stderr.write('update_bulk: filesystem not available\n');
            return 1;
        }
        try {
            const resolvedFile = resolvePath(session.cwd, filePath);
            const data = await fs.read(resolvedFile);
            jsonStr = data.toString();
        } catch (err) {
            io.stderr.write(`update_bulk: cannot read file: ${filePath}\n`);
            return 1;
        }
    } else {
        // Read from stdin
        const chunks: string[] = [];
        for await (const chunk of io.stdin) {
            chunks.push(chunk.toString());
        }
        jsonStr = chunks.join('');
    }

    if (!jsonStr.trim()) {
        io.stderr.write('update_bulk: no data provided\n');
        io.stderr.write('Pipe JSON array to stdin or use --file=<path>\n');
        return 1;
    }

    // Parse JSON
    let records: any[];
    try {
        const data = JSON.parse(jsonStr);
        if (!Array.isArray(data)) {
            io.stderr.write('update_bulk: input must be a JSON array\n');
            io.stderr.write('Use update for single records.\n');
            return 1;
        }
        records = data;
    } catch (err) {
        io.stderr.write('update_bulk: invalid JSON\n');
        return 1;
    }

    if (records.length === 0) {
        io.stderr.write('update_bulk: empty array\n');
        return 1;
    }

    // Validate records have IDs
    for (let i = 0; i < records.length; i++) {
        if (typeof records[i] !== 'object' || records[i] === null) {
            io.stderr.write(`update_bulk: record ${i} is not an object\n`);
            return 1;
        }
        if (!records[i].id) {
            io.stderr.write(`update_bulk: record ${i} missing required "id" field\n`);
            return 1;
        }
    }

    if (dryRun) {
        io.stdout.write(`Dry run: would update ${records.length} records in ${model}\n`);
        return 0;
    }

    // Get Hono app for internal API call
    const app = getHonoApp();
    if (!app) {
        io.stderr.write('update_bulk: internal API not available\n');
        return 1;
    }

    // Generate JWT for the request
    if (!session.systemInit) {
        io.stderr.write('update_bulk: not authenticated\n');
        return 1;
    }

    try {
        const token = await JWTGenerator.fromSystemInit(session.systemInit);

        // Use PATCH for bulk update
        const response = await app.fetch(new Request(`http://localhost/api/data/${model}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(records),
        }));

        if (!response.ok) {
            const errorText = await response.text();
            io.stderr.write(`update_bulk: API error ${response.status}\n`);
            try {
                const errorJson = JSON.parse(errorText);
                io.stderr.write(`${errorJson.error || errorText}\n`);
            } catch {
                io.stderr.write(`${errorText}\n`);
            }
            return 1;
        }

        const result = await response.json() as { data?: any[] } | any[];
        const updated = (result as any).data ?? result;
        const count = Array.isArray(updated) ? updated.length : 1;

        io.stdout.write(`Updated ${count} records in ${model}\n`);
        return 0;

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        io.stderr.write(`update_bulk: ${msg}\n`);
        return 1;
    }
};
