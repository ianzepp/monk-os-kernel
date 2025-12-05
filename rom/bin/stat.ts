/**
 * stat - display file status
 *
 * Usage: stat [options] <file...>
 *
 * Options:
 *   -c <format>     Use custom format
 *   -t              Terse output (single line)
 *
 * Format sequences:
 *   %n      File name
 *   %s      Size in bytes
 *   %F      File type (model)
 *   %i      Entity ID (UUID)
 *   %U      Owner ID
 *   %Y      Modification time (epoch)
 *   %y      Modification time (human)
 *   %Z      Creation time (epoch)
 *   %z      Creation time (human)
 *
 * Examples:
 *   stat file.txt
 *   stat -c "%n: %s bytes" *
 *   stat -t *.json
 */

import {
    getargs,
    getcwd,
    stat,
    println,
    eprintln,
    exit,
} from '@os/process';
import { resolvePath } from '@os/shell';
import type { Stat } from '@os/process';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    if (argv.length === 0) {
        await eprintln('stat: missing operand');
        await eprintln('Usage: stat [options] <file...>');
        await exit(1);
    }

    if (argv[0] === '-h' || argv[0] === '--help') {
        await showHelp();
        await exit(0);
    }

    // Parse options
    let format: string | null = null;
    let terse = false;
    const files: string[] = [];

    let i = 0;

    while (i < argv.length) {
        const arg = argv[i];

        if (!arg) {
            i++;
            continue;
        }

        if (arg === '-c' && i + 1 < argv.length) {
            const nextArg = argv[i + 1];

            if (nextArg) {
                format = nextArg;
            }

            i += 2;
        }
        else if (arg === '-t') {
            terse = true;
            i++;
        }
        else if (arg.startsWith('-') && arg !== '-') {
            await eprintln(`stat: invalid option: ${arg}`);
            await exit(1);
        }
        else {
            files.push(arg);
            i++;
        }
    }

    if (files.length === 0) {
        await eprintln('stat: missing operand');
        await exit(1);
    }

    const cwd = await getcwd();
    let exitCode = 0;

    for (const file of files) {
        const resolved = resolvePath(cwd, file);

        try {
            const entry = await stat(resolved);

            if (format) {
                await println(applyFormat(format, entry, file));
            }
            else if (terse) {
                await println(formatTerse(entry));
            }
            else {
                const lines = formatDefault(entry, file);

                for (const line of lines) {
                    await println(line);
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            await eprintln(`stat: cannot stat '${file}': ${msg}`);
            exitCode = 1;
        }
    }

    await exit(exitCode);
}

function formatTime(date: Date): { epoch: string; human: string } {
    return {
        epoch: Math.floor(date.getTime() / 1000).toString(),
        human: date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    };
}

function getFileType(model: string): string {
    switch (model) {
        case 'folder': return 'directory';
        case 'file': return 'regular file';
        case 'device': return 'device';
        case 'link': return 'symbolic link';
        case 'proc': return 'process info';
        default: return model;
    }
}

function applyFormat(format: string, entry: Stat, _path: string): string {
    const mtime = formatTime(entry.mtime);
    const ctime = formatTime(entry.ctime);

    let result = format;

    result = result.replace(/%n/g, entry.name);
    result = result.replace(/%s/g, String(entry.size));
    result = result.replace(/%F/g, getFileType(entry.model));
    result = result.replace(/%i/g, entry.id);
    result = result.replace(/%U/g, entry.owner);
    result = result.replace(/%Y/g, mtime.epoch);
    result = result.replace(/%y/g, mtime.human);
    result = result.replace(/%Z/g, ctime.epoch);
    result = result.replace(/%z/g, ctime.human);

    result = result.replace(/\\n/g, '\n');
    result = result.replace(/\\t/g, '\t');

    return result;
}

function formatDefault(entry: Stat, _path: string): string[] {
    const lines: string[] = [];
    const mtime = formatTime(entry.mtime);
    const ctime = formatTime(entry.ctime);

    lines.push(`  File: ${entry.name}`);
    lines.push(`  Size: ${entry.size}\t\t${getFileType(entry.model)}`);
    lines.push(`    ID: ${entry.id}`);
    lines.push(` Owner: ${entry.owner}`);
    lines.push(`Modify: ${mtime.human}`);
    lines.push(`Create: ${ctime.human}`);

    return lines;
}

function formatTerse(entry: Stat): string {
    const mtime = Math.floor(entry.mtime.getTime() / 1000);
    const ctime = Math.floor(entry.ctime.getTime() / 1000);

    return [entry.name, entry.size, entry.model, entry.id, entry.owner, mtime, ctime].join(' ');
}

async function showHelp(): Promise<void> {
    await println('Usage: stat [options] <file...>');
    await println('');
    await println('Options:');
    await println('  -c <format>     Custom format');
    await println('  -t              Terse output');
    await println('');
    await println('Format: %n=name %s=size %F=type %i=id %U=owner %y=mtime %z=ctime');
}

main().catch(async err => {
    await eprintln(`stat: ${err.message}`);
    await exit(1);
});
