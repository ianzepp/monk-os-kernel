/**
 * delete_bulk - Bulk delete records
 *
 * Usage:
 *   delete_bulk <model> < ids.txt
 *   delete_bulk <model> --file=ids.txt
 *   echo -e "id1\nid2" | delete_bulk <model>
 *   select id FROM users WHERE status='inactive' | delete_bulk users
 *
 * Input: IDs (one per line) or JSON array of IDs or objects with "id" field.
 * Uses direct API call for efficient bulk deletion.
 *
 * Options:
 *   --file=<path>   Read from file instead of stdin
 *   --dry-run       Validate without deleting
 *
 * Examples:
 *   echo -e "abc-123\ndef-456" | delete_bulk users
 *   delete_bulk products --file=ids.txt
 *   select id FROM users WHERE active=false | delete_bulk users
 */

import type { CommandHandler } from './shared.js';
import { resolvePath } from '../parser.js';
import { getHonoApp } from '@src/lib/internal-api.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';

export const delete_bulk: CommandHandler = async (session, fs, args, io) => {
    if (args.length === 0) {
        io.stderr.write('delete_bulk: missing model\n');
        io.stderr.write('Usage: delete_bulk <model> [--file=<file>] [--dry-run] < ids.txt\n');
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
                io.stderr.write(`delete_bulk: unexpected argument: ${arg}\n`);
                return 1;
            }
        } else {
            io.stderr.write(`delete_bulk: unknown option: ${arg}\n`);
            return 1;
        }
    }

    if (!modelArg) {
        io.stderr.write('delete_bulk: missing model\n');
        return 1;
    }

    // Extract model name (strip /api/data/ prefix if present)
    const model = modelArg.replace(/^\/api\/data\//, '').replace(/\/$/, '');
    if (!model || model.includes('/')) {
        io.stderr.write(`delete_bulk: invalid model: ${modelArg}\n`);
        return 1;
    }

    // Read input
    let inputStr: string;

    if (filePath) {
        // Read from file
        if (!fs) {
            io.stderr.write('delete_bulk: filesystem not available\n');
            return 1;
        }
        try {
            const resolvedFile = resolvePath(session.cwd, filePath);
            const data = await fs.read(resolvedFile);
            inputStr = data.toString();
        } catch (err) {
            io.stderr.write(`delete_bulk: cannot read file: ${filePath}\n`);
            return 1;
        }
    } else {
        // Read from stdin
        const chunks: string[] = [];
        for await (const chunk of io.stdin) {
            chunks.push(chunk.toString());
        }
        inputStr = chunks.join('');
    }

    if (!inputStr.trim()) {
        io.stderr.write('delete_bulk: no IDs provided\n');
        io.stderr.write('Pipe IDs to stdin or use --file=<path>\n');
        return 1;
    }

    // Parse IDs - support multiple formats:
    // 1. JSON array of strings: ["id1", "id2"]
    // 2. JSON array of objects: [{"id": "id1"}, {"id": "id2"}]
    // 3. Newline-separated IDs
    let ids: string[];

    try {
        const parsed = JSON.parse(inputStr);
        if (Array.isArray(parsed)) {
            ids = parsed.map(item => {
                if (typeof item === 'string') return item;
                if (typeof item === 'object' && item !== null && item.id) return item.id;
                throw new Error('Invalid item');
            });
        } else if (typeof parsed === 'string') {
            ids = [parsed];
        } else if (typeof parsed === 'object' && parsed !== null && parsed.id) {
            ids = [parsed.id];
        } else {
            throw new Error('Invalid format');
        }
    } catch {
        // Not JSON, treat as newline-separated IDs
        ids = inputStr.split('\n').map(s => s.trim()).filter(Boolean);
    }

    if (ids.length === 0) {
        io.stderr.write('delete_bulk: no valid IDs found\n');
        return 1;
    }

    if (dryRun) {
        io.stdout.write(`Dry run: would delete ${ids.length} records from ${model}\n`);
        return 0;
    }

    // Get Hono app for internal API call
    const app = getHonoApp();
    if (!app) {
        io.stderr.write('delete_bulk: internal API not available\n');
        return 1;
    }

    // Generate JWT for the request
    if (!session.systemInit) {
        io.stderr.write('delete_bulk: not authenticated\n');
        return 1;
    }

    try {
        const token = await JWTGenerator.fromSystemInit(session.systemInit);

        // Use DELETE with body containing IDs
        const response = await app.fetch(new Request(`http://localhost/api/data/${model}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ids }),
        }));

        if (!response.ok) {
            const errorText = await response.text();
            io.stderr.write(`delete_bulk: API error ${response.status}\n`);
            try {
                const errorJson = JSON.parse(errorText);
                io.stderr.write(`${errorJson.error || errorText}\n`);
            } catch {
                io.stderr.write(`${errorText}\n`);
            }
            return 1;
        }

        const result = await response.json() as { data?: any[], count?: number } | any[];
        const deleted = (result as any).data ?? result;
        const count = (result as any).count ?? (Array.isArray(deleted) ? deleted.length : ids.length);

        io.stdout.write(`Deleted ${count} records from ${model}\n`);
        return 0;

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        io.stderr.write(`delete_bulk: ${msg}\n`);
        return 1;
    }
};
