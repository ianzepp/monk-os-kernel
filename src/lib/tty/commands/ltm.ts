/**
 * ltm - Long Term Memory
 *
 * Append-only memory storage with full-text search.
 * Stored in the 'memories' database table.
 *
 * Usage:
 *   ltm add <text>          Append a new memory
 *   ltm search <query>      Full-text search memories
 *   ltm list [limit]        List recent memories (default 20)
 *   ltm delete <id>         Delete a memory by ID
 */

import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';
import { getHonoApp } from '@src/lib/internal-api.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';

export const ltm: CommandHandler = async (session, _fs, args, io) => {
    const { positional } = parseArgs(args, {});

    const subcommand = positional[0];

    if (!session.systemInit) {
        io.stderr.write('ltm: database not available\n');
        return 1;
    }

    const app = getHonoApp();
    if (!app) {
        io.stderr.write('ltm: internal API not available\n');
        return 1;
    }

    const token = await JWTGenerator.fromSystemInit(session.systemInit);

    switch (subcommand) {
        case 'add': {
            const content = positional.slice(1).join(' ');
            if (!content) {
                io.stderr.write('ltm add: missing content\n');
                return 1;
            }

            const response = await app.fetch(new Request('http://localhost/api/data/memories', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    owner: session.username,
                    content,
                }),
            }));

            if (!response.ok) {
                const text = await response.text();
                io.stderr.write(`ltm add: ${text}\n`);
                return 1;
            }

            const result = await response.json() as { id: string };
            io.stdout.write(`${result.id}\n`);
            return 0;
        }

        case 'search': {
            const query = positional.slice(1).join(' ');
            if (!query) {
                io.stderr.write('ltm search: missing query\n');
                return 1;
            }

            const response = await app.fetch(new Request('http://localhost/api/find/memories', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    where: {
                        owner: session.username,
                        content: { $search: query },
                    },
                    order: { created_at: 'desc' },
                    limit: 50,
                }),
            }));

            if (!response.ok) {
                const text = await response.text();
                io.stderr.write(`ltm search: ${text}\n`);
                return 1;
            }

            const result = await response.json() as { data: any[] };
            const memories = result.data || [];

            if (memories.length === 0) {
                io.stdout.write('(no matches)\n');
            } else {
                for (const mem of memories) {
                    const date = new Date(mem.created_at).toISOString().slice(0, 10);
                    io.stdout.write(`[${mem.id.slice(0, 8)}] ${date}: ${mem.content}\n`);
                }
            }
            return 0;
        }

        case 'list':
        case undefined: {
            const limit = parseInt(positional[1], 10) || 20;

            const response = await app.fetch(new Request('http://localhost/api/find/memories', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    where: { owner: session.username },
                    order: { created_at: 'desc' },
                    limit,
                }),
            }));

            if (!response.ok) {
                const text = await response.text();
                io.stderr.write(`ltm list: ${text}\n`);
                return 1;
            }

            const result = await response.json() as { data: any[] };
            const memories = result.data || [];

            if (memories.length === 0) {
                io.stdout.write('(no memories)\n');
            } else {
                for (const mem of memories) {
                    const date = new Date(mem.created_at).toISOString().slice(0, 10);
                    io.stdout.write(`[${mem.id.slice(0, 8)}] ${date}: ${mem.content}\n`);
                }
            }
            return 0;
        }

        case 'delete':
        case 'rm': {
            const id = positional[1];
            if (!id) {
                io.stderr.write('ltm delete: missing id\n');
                return 1;
            }

            // First verify ownership
            const checkResponse = await app.fetch(new Request(`http://localhost/api/data/memories/${id}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                },
            }));

            if (!checkResponse.ok) {
                io.stderr.write(`ltm delete: memory not found\n`);
                return 1;
            }

            const memory = await checkResponse.json() as { owner: string };
            if (memory.owner !== session.username) {
                io.stderr.write(`ltm delete: permission denied\n`);
                return 1;
            }

            const response = await app.fetch(new Request(`http://localhost/api/data/memories/${id}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`,
                },
            }));

            if (!response.ok) {
                const text = await response.text();
                io.stderr.write(`ltm delete: ${text}\n`);
                return 1;
            }

            return 0;
        }

        default:
            io.stderr.write(`ltm: unknown subcommand: ${subcommand}\n`);
            io.stderr.write('usage: ltm [add|search|list|delete] [args]\n');
            return 1;
    }
};
