/**
 * mount - Mount filesystems or display mounted filesystems
 *
 * Usage:
 *   mount                              List all mounts
 *   mount -t local <source> <target>   Mount local directory
 *   mount -t local -r <source> <target> Mount read-only
 *   mount -t find <model> <query> <target>  Mount query results
 *
 * Examples:
 *   mount
 *   mount -t local /real/path/to/dist /dist
 *   mount -t local -r /home/user/projects /projects
 *   mount -t find accounts '{"where":{"balance":{"$gt":1000000}}}' /home/root/rich
 *
 * Output format (Linux-style):
 *   /dev/data on /api/data (crud)
 *   /dev/find on /home/root/rich (accounts, where:{...}, saved)
 */

import { LocalMount } from '@src/lib/fs/index.js';
import { FindMount } from '@src/lib/fs/mounts/find-mount.js';
import { resolvePath } from '../parser.js';
import { saveMountConfig } from '../profile.js';
import type { CommandHandler } from './shared.js';
import type { SessionMount } from '../types.js';

/** Map mount class names to device names and info formatters */
const MOUNT_INFO: Record<string, { dev: string; info: (m: any, saved: boolean) => string }> = {
    DataMount: { dev: '/dev/data', info: () => 'crud' },
    DescribeMount: { dev: '/dev/describe', info: () => 'readonly' },
    FilterMount: { dev: '/dev/filter', info: () => 'readonly' },
    TrashedMount: { dev: '/dev/trashed', info: () => 'readonly' },
    ProcMount: { dev: '/dev/proc', info: () => 'readonly' },
    BinMount: { dev: '/dev/bin', info: () => 'readonly' },
    SystemMount: { dev: '/dev/system', info: () => 'readonly' },
    MemoryMount: { dev: '/dev/mem', info: () => 'memory, 500MB' },
    DatabaseMount: { dev: '/dev/db', info: () => 'database' },
    LocalMount: { dev: '/dev/local', info: (m, saved) => {
        const parts = [`local:${m.rootPath || '?'}`];
        if (m.writable === false) parts.push('readonly');
        if (saved) parts.push('saved');
        return parts.join(', ');
    }},
    FindMount: { dev: '/dev/find', info: (m, saved) => {
        const parts = [m.modelName || '?'];
        if (m.query?.where) parts.push(`where:${JSON.stringify(m.query.where)}`);
        if (m.query?.limit) parts.push(`limit:${m.query.limit}`);
        if (saved) parts.push('saved');
        return parts.join(', ');
    }},
};

/**
 * Format mount info from session mount config
 */
function formatSessionMount(mountPath: string, config: SessionMount, saved: boolean): string {
    if (config.type === 'local') {
        const parts = [`local:${config.path}`];
        if (config.readonly) parts.push('readonly');
        if (saved) parts.push('saved');
        return `/dev/local on ${mountPath} (${parts.join(', ')})`;
    } else if (config.type === 'find') {
        const parts = [config.model];
        if (config.query?.where) parts.push(`where:${JSON.stringify(config.query.where)}`);
        if (config.query?.limit) parts.push(`limit:${config.query.limit}`);
        if (saved) parts.push('saved');
        return `/dev/find on ${mountPath} (${parts.join(', ')})`;
    }
    return `/dev/unknown on ${mountPath} (?)`;
}

export const mount: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('mount: filesystem not available\n');
        return 1;
    }

    // No args: list mounts
    if (args.length === 0) {
        const mounts = fs.getMounts();
        const fallback = fs.getFallback();

        // Collect all mount entries
        const entries: Array<{ path: string; line: string }> = [];

        // Add explicit mounts
        for (const [path, handler] of mounts) {
            const className = handler.constructor.name;
            const info = MOUNT_INFO[className];

            // Check if this is a saved user mount
            const sessionMount = session.mounts.get(path);
            const isSaved = !!sessionMount; // TODO: check actual saved file

            if (info) {
                const details = info.info(handler, isSaved);
                entries.push({ path, line: `${info.dev} on ${path} (${details})` });
            } else {
                entries.push({ path, line: `/dev/${className.toLowerCase()} on ${path}` });
            }
        }

        // Add fallback mount
        if (fallback) {
            const className = fallback.constructor.name;
            const info = MOUNT_INFO[className];
            if (info) {
                entries.push({ path: '/', line: `${info.dev} on / (${info.info(fallback, false)})` });
            }
        }

        // Sort by path and output
        entries.sort((a, b) => a.path.localeCompare(b.path));
        for (const entry of entries) {
            io.stdout.write(entry.line + '\n');
        }
        return 0;
    }

    // Parse mount arguments
    let type: string | undefined;
    let readonly = false;
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-t' && args[i + 1]) {
            type = args[++i];
        } else if (arg === '-r' || arg === '--readonly') {
            readonly = true;
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
    }

    if (!type) {
        io.stderr.write('mount: missing type (-t)\n');
        io.stderr.write('Usage: mount -t local <source> <target>\n');
        io.stderr.write('       mount -t find <model> <query> <target>\n');
        return 1;
    }

    // Handle mount types
    switch (type) {
        case 'local': {
            if (positional.length !== 2) {
                io.stderr.write('mount: requires source and target paths\n');
                io.stderr.write('Usage: mount -t local <source> <target>\n');
                return 1;
            }

            const [source, target] = positional;

            // Source is a real filesystem path on the HOST
            // Note: ~ is expanded by the parser to the virtual $HOME before we see it
            // Users must use absolute paths for host filesystem mounts
            const realPath = source;

            // Target is a virtual filesystem path
            const virtualPath = resolvePath(session.cwd, target);

            try {
                const localMount = new LocalMount(realPath, {
                    writable: !readonly,
                });

                // Mount on current FS
                fs.mount(virtualPath, localMount);

                // Store in session for persistence across transactions
                const config: SessionMount = {
                    type: 'local',
                    path: realPath,
                    readonly,
                };
                session.mounts.set(virtualPath, config);

                // Auto-save to ~/.config/mounts.json
                await saveMountConfig(session, virtualPath, config);

                io.stdout.write(`Mounted ${realPath} on ${virtualPath}${readonly ? ' (read-only)' : ''}\n`);
                return 0;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                io.stderr.write(`mount: ${message}\n`);
                return 1;
            }
        }

        case 'find': {
            if (positional.length !== 3) {
                io.stderr.write('mount: requires model, query, and target\n');
                io.stderr.write('Usage: mount -t find <model> <query-json> <target>\n');
                io.stderr.write('Example: mount -t find accounts \'{"where":{"active":true}}\' /home/root/active\n');
                return 1;
            }

            const [model, queryJson, target] = positional;
            const virtualPath = resolvePath(session.cwd, target);

            // Parse the query JSON
            let query: Record<string, any>;
            try {
                query = JSON.parse(queryJson);
            } catch {
                io.stderr.write('mount: invalid JSON query\n');
                io.stderr.write('Example: \'{"where":{"balance":{"$gt":1000}}}\'\n');
                return 1;
            }

            try {
                // Store in session - applied in applySessionMounts when we have System context
                const config: SessionMount = {
                    type: 'find',
                    model,
                    query,
                };
                session.mounts.set(virtualPath, config);

                // Auto-save to ~/.config/mounts.json
                await saveMountConfig(session, virtualPath, config);

                io.stdout.write(`Mounted find query on ${virtualPath}\n`);
                io.stdout.write(`  model: ${model}\n`);
                if (query.where) io.stdout.write(`  where: ${JSON.stringify(query.where)}\n`);
                if (query.order) io.stdout.write(`  order: ${JSON.stringify(query.order)}\n`);
                if (query.limit) io.stdout.write(`  limit: ${query.limit}\n`);
                return 0;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                io.stderr.write(`mount: ${message}\n`);
                return 1;
            }
        }

        default:
            io.stderr.write(`mount: unknown type '${type}'\n`);
            io.stderr.write('Supported types: local, find\n');
            return 1;
    }
};
