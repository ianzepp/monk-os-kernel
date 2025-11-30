/**
 * df - report filesystem disk space usage
 *
 * Usage:
 *   df [options] [file...]
 *
 * Options:
 *   -h              Human-readable sizes (1K, 2M, 3G)
 *   -H              Human-readable with SI units (1000 base)
 *   -T              Show filesystem type
 *   -i              Show inode information
 *   -a              Include pseudo-filesystems
 *   -l              Local filesystems only
 *   -t <type>       Show only filesystems of type
 *   -x <type>       Exclude filesystems of type
 *   --total         Produce a grand total
 *
 * Note: Values are simulated for the virtual filesystem.
 *
 * Examples:
 *   df
 *   df -h
 *   df -Th /api/data
 */

import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';

const argSpecs = {
    human: { short: 'h', desc: 'Human readable (1024)' },
    humanSI: { short: 'H', desc: 'Human readable (1000)' },
    showType: { short: 'T', desc: 'Show type' },
    inodes: { short: 'i', desc: 'Show inodes' },
    all: { short: 'a', desc: 'Include all' },
    local: { short: 'l', desc: 'Local only' },
    type: { short: 't', value: true, desc: 'Filter by type' },
    exclude: { short: 'x', value: true, desc: 'Exclude type' },
    total: { long: 'total', desc: 'Grand total' },
};

type DfOptions = {
    human: boolean;
    humanSI: boolean;
    showType: boolean;
    inodes: boolean;
    all: boolean;
    total: boolean;
    typeFilter: string | null;
    excludeType: string | null;
};

type FsInfo = {
    filesystem: string;
    type: string;
    size: number;
    used: number;
    available: number;
    usePercent: number;
    mountpoint: string;
    inodes: number;
    inodesUsed: number;
};

/**
 * Format size based on options
 */
function formatSize(bytes: number, options: DfOptions): string {
    if (!options.human && !options.humanSI) {
        // Default: 1K blocks
        return String(Math.ceil(bytes / 1024));
    }

    const base = options.humanSI ? 1000 : 1024;
    const units = options.humanSI ? ['B', 'kB', 'MB', 'GB', 'TB'] : ['', 'K', 'M', 'G', 'T'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= base && unitIndex < units.length - 1) {
        size /= base;
        unitIndex++;
    }

    if (unitIndex === 0 && !options.humanSI) {
        return String(Math.round(size));
    }

    const formatted = size.toFixed(size < 10 && unitIndex > 0 ? 1 : 0);
    return formatted + units[unitIndex];
}

/**
 * Get filesystem info (simulated)
 */
function getFilesystemInfo(mountpoint: string): FsInfo {
    // Simulate realistic values for different mount points
    const fsMap: Record<string, Partial<FsInfo>> = {
        '/': {
            filesystem: 'rootfs',
            type: 'vfs',
            size: 10 * 1024 * 1024 * 1024, // 10GB
            used: 2 * 1024 * 1024 * 1024,  // 2GB
        },
        '/tmp': {
            filesystem: 'tmpfs',
            type: 'tmpfs',
            size: 512 * 1024 * 1024,       // 512MB
            used: 10 * 1024 * 1024,        // 10MB
        },
        '/api': {
            filesystem: 'apistore',
            type: 'api',
            size: 100 * 1024 * 1024 * 1024, // 100GB
            used: 5 * 1024 * 1024 * 1024,   // 5GB
        },
        '/proc': {
            filesystem: 'proc',
            type: 'proc',
            size: 0,
            used: 0,
        },
        '/home': {
            filesystem: 'homefs',
            type: 'vfs',
            size: 50 * 1024 * 1024 * 1024,  // 50GB
            used: 1 * 1024 * 1024 * 1024,   // 1GB
        },
    };

    // Find best matching mount
    let bestMatch = '/';
    for (const mount of Object.keys(fsMap)) {
        if (mountpoint.startsWith(mount) && mount.length > bestMatch.length) {
            bestMatch = mount;
        }
    }

    const info = fsMap[bestMatch] || fsMap['/'];
    const size = info.size || 10 * 1024 * 1024 * 1024;
    const used = info.used || 0;
    const available = size - used;
    const usePercent = size > 0 ? Math.round((used / size) * 100) : 0;

    return {
        filesystem: info.filesystem || 'vfs',
        type: info.type || 'vfs',
        size,
        used,
        available,
        usePercent,
        mountpoint: bestMatch,
        inodes: 1000000,
        inodesUsed: 10000,
    };
}

export const df: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`df: ${err}\n`);
        }
        return 1;
    }

    const options: DfOptions = {
        human: Boolean(parsed.flags.human),
        humanSI: Boolean(parsed.flags.humanSI),
        showType: Boolean(parsed.flags.showType),
        inodes: Boolean(parsed.flags.inodes),
        all: Boolean(parsed.flags.all),
        total: Boolean(parsed.flags.total),
        typeFilter: typeof parsed.flags.type === 'string' ? parsed.flags.type : null,
        excludeType: typeof parsed.flags.exclude === 'string' ? parsed.flags.exclude : null,
    };

    // Determine which filesystems to show
    let mounts: string[];
    if (parsed.positional.length > 0) {
        mounts = parsed.positional.map(p => resolvePath(session.cwd, p));
    } else {
        mounts = ['/', '/tmp', '/api', '/home'];
        if (options.all) {
            mounts.push('/proc');
        }
    }

    // Gather info
    const infos = mounts.map(m => getFilesystemInfo(m));

    // Filter by type
    let filtered = infos;
    if (options.typeFilter) {
        filtered = filtered.filter(i => i.type === options.typeFilter);
    }
    if (options.excludeType) {
        filtered = filtered.filter(i => i.type !== options.excludeType);
    }

    // Remove duplicates by mountpoint
    const seen = new Set<string>();
    filtered = filtered.filter(i => {
        if (seen.has(i.mountpoint)) return false;
        seen.add(i.mountpoint);
        return true;
    });

    // Build header
    const headers: string[] = ['Filesystem'];
    if (options.showType) headers.push('Type');
    if (options.inodes) {
        headers.push('Inodes', 'IUsed', 'IFree', 'IUse%');
    } else {
        const sizeHeader = options.human || options.humanSI ? 'Size' : '1K-blocks';
        headers.push(sizeHeader, 'Used', 'Avail', 'Use%');
    }
    headers.push('Mounted on');

    // Column widths
    const widths = headers.map(h => h.length);

    // Build rows
    const rows: string[][] = [];
    let totalSize = 0, totalUsed = 0, totalAvail = 0;

    for (const info of filtered) {
        const row: string[] = [info.filesystem];
        if (options.showType) row.push(info.type);

        if (options.inodes) {
            row.push(
                String(info.inodes),
                String(info.inodesUsed),
                String(info.inodes - info.inodesUsed),
                Math.round((info.inodesUsed / info.inodes) * 100) + '%'
            );
        } else {
            row.push(
                formatSize(info.size, options),
                formatSize(info.used, options),
                formatSize(info.available, options),
                info.usePercent + '%'
            );
            totalSize += info.size;
            totalUsed += info.used;
            totalAvail += info.available;
        }
        row.push(info.mountpoint);
        rows.push(row);

        // Update widths
        for (let i = 0; i < row.length; i++) {
            widths[i] = Math.max(widths[i], row[i].length);
        }
    }

    // Add total row if requested
    if (options.total && !options.inodes) {
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
            widths[i] = Math.max(widths[i], totalRow[i].length);
        }
    }

    // Output header
    io.stdout.write(headers.map((h, i) => h.padEnd(widths[i])).join('  ') + '\n');

    // Output rows
    for (const row of rows) {
        io.stdout.write(row.map((c, i) => c.padEnd(widths[i])).join('  ') + '\n');
    }

    return 0;
};
