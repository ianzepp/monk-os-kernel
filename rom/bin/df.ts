/**
 * df - report filesystem disk space usage
 *
 * Usage: df [options] [file...]
 *
 * Options:
 *   -h              Human-readable sizes
 *   -T              Show filesystem type
 *   --total         Produce a grand total
 *
 * Note: Values are simulated for the virtual filesystem.
 *
 * Examples:
 *   df
 *   df -h
 *   df -Th /home
 */

import {
    getargs,
    getcwd,
    println,
    eprintln,
    exit,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';

type DfOptions = {
    human: boolean;
    showType: boolean;
    total: boolean;
};

type FsInfo = {
    filesystem: string;
    type: string;
    size: number;
    used: number;
    available: number;
    usePercent: number;
    mountpoint: string;
};

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    if (argv[0] === '-h' && argv.length === 1) {
        // -h alone means human-readable, not help
    }
    if (argv[0] === '--help') {
        await println('Usage: df [options] [file...]');
        await println('Options: -h (human-readable), -T (show type), --total');
        await exit(0);
    }

    // Parse options
    const options: DfOptions = {
        human: false,
        showType: false,
        total: false,
    };
    const targets: string[] = [];

    for (const arg of argv) {
        if (arg === '-h') options.human = true;
        else if (arg === '-T') options.showType = true;
        else if (arg === '--total') options.total = true;
        else if (!arg.startsWith('-')) targets.push(arg);
    }

    const cwd = await getcwd();

    // Determine mounts to show
    let mounts: string[];
    if (targets.length > 0) {
        mounts = targets.map(t => resolvePath(cwd, t));
    } else {
        mounts = ['/', '/home', '/tmp', '/dev', '/proc'];
    }

    // Get info for each mount
    const infos = mounts.map(m => getFilesystemInfo(m));

    // Remove duplicates
    const seen = new Set<string>();
    const filtered = infos.filter(i => {
        if (seen.has(i.mountpoint)) return false;
        seen.add(i.mountpoint);
        return true;
    });

    // Build header
    const headers: string[] = ['Filesystem'];
    if (options.showType) headers.push('Type');
    headers.push(options.human ? 'Size' : '1K-blocks', 'Used', 'Avail', 'Use%', 'Mounted on');

    // Calculate widths
    const widths = headers.map(h => h.length);

    // Build rows
    const rows: string[][] = [];
    let totalSize = 0, totalUsed = 0, totalAvail = 0;

    for (const info of filtered) {
        const row: string[] = [info.filesystem];
        if (options.showType) row.push(info.type);
        row.push(
            formatSize(info.size, options),
            formatSize(info.used, options),
            formatSize(info.available, options),
            info.usePercent + '%',
            info.mountpoint
        );
        rows.push(row);

        totalSize += info.size;
        totalUsed += info.used;
        totalAvail += info.available;

        for (let i = 0; i < row.length; i++) {
            const cell = row[i];
            const currentWidth = widths[i];
            if (cell && currentWidth !== undefined) {
                widths[i] = Math.max(currentWidth, cell.length);
            }
        }
    }

    // Add total row
    if (options.total) {
        const totalRow: string[] = ['total'];
        if (options.showType) totalRow.push('-');
        totalRow.push(
            formatSize(totalSize, options),
            formatSize(totalUsed, options),
            formatSize(totalAvail, options),
            totalSize > 0 ? Math.round((totalUsed / totalSize) * 100) + '%' : '0%',
            '-'
        );
        rows.push(totalRow);
        for (let i = 0; i < totalRow.length; i++) {
            const cell = totalRow[i];
            const currentWidth = widths[i];
            if (cell && currentWidth !== undefined) {
                widths[i] = Math.max(currentWidth, cell.length);
            }
        }
    }

    // Output
    await println(headers.map((h, i) => {
        const w = widths[i];
        return w ? h.padEnd(w) : h;
    }).join('  '));
    for (const row of rows) {
        await println(row.map((c, i) => {
            const w = widths[i];
            return w ? c.padEnd(w) : c;
        }).join('  '));
    }

    await exit(0);
}

function getFilesystemInfo(path: string): FsInfo {
    // Simulated values for virtual filesystem
    const fsMap: Record<string, Partial<FsInfo>> = {
        '/': { filesystem: 'rootfs', type: 'vfs', size: 10 * 1024 * 1024 * 1024, used: 2 * 1024 * 1024 * 1024 },
        '/home': { filesystem: 'homefs', type: 'vfs', size: 50 * 1024 * 1024 * 1024, used: 1 * 1024 * 1024 * 1024 },
        '/tmp': { filesystem: 'tmpfs', type: 'tmpfs', size: 512 * 1024 * 1024, used: 10 * 1024 * 1024 },
        '/dev': { filesystem: 'devfs', type: 'devfs', size: 0, used: 0 },
        '/proc': { filesystem: 'procfs', type: 'proc', size: 0, used: 0 },
    };

    let bestMatch = '/';
    for (const mount of Object.keys(fsMap)) {
        if (path.startsWith(mount) && mount.length > bestMatch.length) {
            bestMatch = mount;
        }
    }

    const info = fsMap[bestMatch];
    if (!info) {
        const defaultInfo = fsMap['/'];
        const defaultSize = defaultInfo?.size || 10 * 1024 * 1024 * 1024;
        const defaultUsed = defaultInfo?.used || 0;
        return {
            filesystem: defaultInfo?.filesystem || 'vfs',
            type: defaultInfo?.type || 'vfs',
            size: defaultSize,
            used: defaultUsed,
            available: defaultSize - defaultUsed,
            usePercent: defaultSize > 0 ? Math.round((defaultUsed / defaultSize) * 100) : 0,
            mountpoint: bestMatch,
        };
    }

    const size = info.size || 10 * 1024 * 1024 * 1024;
    const used = info.used || 0;

    return {
        filesystem: info.filesystem || 'vfs',
        type: info.type || 'vfs',
        size,
        used,
        available: size - used,
        usePercent: size > 0 ? Math.round((used / size) * 100) : 0,
        mountpoint: bestMatch,
    };
}

function formatSize(bytes: number, options: DfOptions): string {
    if (!options.human) {
        return String(Math.ceil(bytes / 1024));
    }

    const units = ['', 'K', 'M', 'G', 'T'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    const formatted = unitIndex === 0 ? String(Math.round(size)) : size.toFixed(size < 10 ? 1 : 0);
    return formatted + units[unitIndex];
}

main().catch(async (err) => {
    await eprintln(`df: ${err.message}`);
    await exit(1);
});
