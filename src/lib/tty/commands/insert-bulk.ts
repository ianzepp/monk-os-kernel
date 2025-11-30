/**
 * insert_bulk - Bulk insert records
 *
 * Usage:
 *   insert_bulk <model> < data.json
 *   insert_bulk <model> --file=data.json
 *   cat data.json | insert_bulk <model>
 *
 * Input must be a JSON array of records.
 * Uses direct API call for efficient bulk insertion.
 *
 * Options:
 *   --file=<path>   Read from file instead of stdin
 *   --dry-run       Validate without inserting
 *
 * Examples:
 *   cat users.json | insert_bulk users
 *   insert_bulk products --file=products.json
 *   insert_bulk orders --dry-run < orders.json
 */

import type { CommandHandler } from './shared.js';
import { resolvePath } from '../parser.js';
import { getHonoApp } from '@src/lib/internal-api.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';

export const insert_bulk: CommandHandler = async (session, fs, args, io) => {
    if (args.length === 0) {
        io.stderr.write('insert_bulk: missing model\n');
        io.stderr.write('Usage: insert_bulk <model> [--file=<file>] [--dry-run] < data.json\n');
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
                io.stderr.write(`insert_bulk: unexpected argument: ${arg}\n`);
                io.stderr.write('Note: insert_bulk does not accept field=value pairs. Use insert for single records.\n');
                return 1;
            }
        } else {
            io.stderr.write(`insert_bulk: unknown option: ${arg}\n`);
            return 1;
        }
    }

    if (!modelArg) {
        io.stderr.write('insert_bulk: missing model\n');
        return 1;
    }

    // Extract model name (strip /api/data/ prefix if present)
    const model = modelArg.replace(/^\/api\/data\//, '').replace(/\/$/, '');
    if (!model || model.includes('/')) {
        io.stderr.write(`insert_bulk: invalid model: ${modelArg}\n`);
        return 1;
    }

    // Read JSON input
    let jsonStr: string;

    if (filePath) {
        // Read from file
        if (!fs) {
            io.stderr.write('insert_bulk: filesystem not available\n');
            return 1;
        }
        try {
            const resolvedFile = resolvePath(session.cwd, filePath);
            const data = await fs.read(resolvedFile);
            jsonStr = data.toString();
        } catch (err) {
            io.stderr.write(`insert_bulk: cannot read file: ${filePath}\n`);
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
        io.stderr.write('insert_bulk: no data provided\n');
        io.stderr.write('Pipe JSON array to stdin or use --file=<path>\n');
        return 1;
    }

    // Parse JSON
    let records: any[];
    try {
        const data = JSON.parse(jsonStr);
        if (!Array.isArray(data)) {
            io.stderr.write('insert_bulk: input must be a JSON array\n');
            io.stderr.write('Use insert for single records.\n');
            return 1;
        }
        records = data;
    } catch (err) {
        io.stderr.write('insert_bulk: invalid JSON\n');
        return 1;
    }

    if (records.length === 0) {
        io.stderr.write('insert_bulk: empty array\n');
        return 1;
    }

    // Validate records (basic check)
    for (let i = 0; i < records.length; i++) {
        if (typeof records[i] !== 'object' || records[i] === null) {
            io.stderr.write(`insert_bulk: record ${i} is not an object\n`);
            return 1;
        }
    }

    if (dryRun) {
        io.stdout.write(`Dry run: would insert ${records.length} records into ${model}\n`);
        return 0;
    }

    // Get Hono app for internal API call
    const app = getHonoApp();
    if (!app) {
        io.stderr.write('insert_bulk: internal API not available\n');
        return 1;
    }

    // Generate JWT for the request
    if (!session.systemInit) {
        io.stderr.write('insert_bulk: not authenticated\n');
        return 1;
    }

    try {
        const token = await JWTGenerator.fromSystemInit(session.systemInit);

        const response = await app.fetch(new Request(`http://localhost/api/data/${model}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(records),
        }));

        if (!response.ok) {
            const errorText = await response.text();
            io.stderr.write(`insert_bulk: API error ${response.status}\n`);
            try {
                const errorJson = JSON.parse(errorText);
                io.stderr.write(`${errorJson.error || errorText}\n`);
            } catch {
                io.stderr.write(`${errorText}\n`);
            }
            return 1;
        }

        const result = await response.json() as { data?: any[] } | any[];
        const inserted = (result as any).data ?? result;
        const count = Array.isArray(inserted) ? inserted.length : 1;

        io.stdout.write(`Inserted ${count} records into ${model}\n`);
        return 0;

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        io.stderr.write(`insert_bulk: ${msg}\n`);
        return 1;
    }
};
