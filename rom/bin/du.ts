/**
 * du - estimate file space usage
 *
 * Usage: du [options] [file...]
 *
 * Options:
 *   -a              Show all files, not just directories
 *   -h              Human-readable sizes (1K, 2M, 3G)
 *   -s              Summary only (total for each argument)
 *   -c              Produce a grand total
 *   -d <depth>      Max depth to display
 *   -b              Apparent size in bytes
 *   -k              Size in kilobytes (default)
 *   -m              Size in megabytes
 *
 * Examples:
 *   du                    Current directory
 *   du -sh /home          Summary with human sizes
 *   du -ah /tmp           All files, human sizes
 *   du -d 1 /             One level deep
 */

import {
    getargs,
    getcwd,
    stat,
    readdirAll,
    println,
    eprintln,
    exit,
} from '@rom/lib/process/index.js';
import { resolvePath } from '@rom/lib/shell';

interface DuOptions {
    all: boolean;
    human: boolean;
    summary: boolean;
    total: boolean;
    maxDepth: number;
    unit: 'bytes' | 'kilobytes' | 'megabytes';
}

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    if (argv[0] === '-h' || argv[0] === '--help') {
        await showHelp();
        await exit(0);
    }

    // Parse options
    const options: DuOptions = {
        all: false,
        human: false,
        summary: false,
        total: false,
        maxDepth: Infinity,
        unit: 'kilobytes',
    };
    const targets: string[] = [];

    let i = 0;

    while (i < argv.length) {
        const arg = argv[i];

        if (arg === undefined) {
            i++; continue;
        }

        if (arg === '-a') {
            options.all = true; i++;
        }
        else if (arg === '-h') {
            options.human = true; i++;
        }
        else if (arg === '-s') {
            options.summary = true; options.maxDepth = 0; i++;
        }
        else if (arg === '-c') {
            options.total = true; i++;
        }
        else if (arg === '-b') {
            options.unit = 'bytes'; i++;
        }
        else if (arg === '-k') {
            options.unit = 'kilobytes'; i++;
        }
        else if (arg === '-m') {
            options.unit = 'megabytes'; i++;
        }
        else if (arg === '-d' && i + 1 < argv.length) {
            const val = argv[i + 1];

            if (val === undefined) {
                i += 2; continue;
            }

            options.maxDepth = parseInt(val, 10);
            i += 2;
        }
        else if (!arg.startsWith('-')) {
            targets.push(arg);
            i++;
        }
        else {
            i++;
        }
    }

    if (targets.length === 0) {
        targets.push('.');
    }

    const cwd = await getcwd();
    let grandTotal = 0;
    let exitCode = 0;

    for (const target of targets) {
        const resolved = resolvePath(cwd, target);
        const results: { path: string; size: number }[] = [];

        try {
            const size = await calculateSize(resolved, options, 0, results);

            for (const result of results) {
                await println(`${formatSize(result.size, options)}\t${result.path}`);
            }

            if (options.summary) {
                await println(`${formatSize(size, options)}\t${resolved}`);
            }

            grandTotal += size;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            await eprintln(`du: ${target}: ${msg}`);
            exitCode = 1;
        }
    }

    if (options.total) {
        await println(`${formatSize(grandTotal, options)}\ttotal`);
    }

    await exit(exitCode);
}

async function calculateSize(
    path: string,
    options: DuOptions,
    depth: number,
    results: { path: string; size: number }[],
): Promise<number> {
    const entry = await stat(path);

    if (entry.model !== 'folder') {
        if (options.all && !options.summary && depth <= options.maxDepth) {
            results.push({ path, size: entry.size });
        }

        return entry.size;
    }

    const entries = await readdirAll(path);
    let totalSize = 0;

    for (const child of entries) {
        const childPath = path === '/' ? `/${child}` : `${path}/${child}`;

        try {
            const childSize = await calculateSize(childPath, options, depth + 1, results);

            totalSize += childSize;
        }
        catch {
            // Skip inaccessible entries
        }
    }

    if (!options.summary && depth <= options.maxDepth) {
        results.push({ path, size: totalSize });
    }

    return totalSize;
}

function formatSize(bytes: number, options: DuOptions): string {
    if (options.human) {
        const units = ['', 'K', 'M', 'G', 'T'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        const formatted = unitIndex === 0 ? String(size) : size.toFixed(size < 10 ? 1 : 0);

        return formatted + units[unitIndex];
    }

    switch (options.unit) {
        case 'bytes': return String(bytes);
        case 'megabytes': return String(Math.ceil(bytes / (1024 * 1024)));
        default: return String(Math.ceil(bytes / 1024));
    }
}

async function showHelp(): Promise<void> {
    await println('Usage: du [options] [file...]');
    await println('');
    await println('Options:');
    await println('  -a          All files');
    await println('  -h          Human-readable');
    await println('  -s          Summary only');
    await println('  -c          Grand total');
    await println('  -d <depth>  Max depth');
    await println('  -b/-k/-m    Bytes/KB/MB');
}

main().catch(async err => {
    await eprintln(`du: ${err.message}`);
    await exit(1);
});
