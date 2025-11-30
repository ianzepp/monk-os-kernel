/**
 * xargs - Build and execute commands from stdin
 *
 * Usage:
 *   <input> | xargs [options] <command> [args...]
 *
 * Options:
 *   -0              Input items are NUL-separated (for find -print0)
 *   -d <delim>      Use delimiter instead of whitespace
 *   -I <replace>    Replace string in command (implies -n 1)
 *   -n <max>        Use at most max arguments per command
 *   -t              Print commands before executing (trace)
 *   -r              Don't run command if stdin is empty
 *   -L <max>        Use at most max lines per command
 *   -P <max>        Run up to max processes in parallel
 *
 * Examples:
 *   find . -type f | xargs cat              Cat all files
 *   find . -print0 | xargs -0 rm            Safe delete with NUL separator
 *   echo "a b c" | xargs -n1 echo           One arg per command
 *   find . | xargs -I {} cp {} /backup/     Use replacement string
 *   find . -type f | xargs -P4 -n10 gzip    Parallel with batching
 */

import { PassThrough } from 'node:stream';
import type { FS } from '@src/lib/fs/index.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';
import type { Session, CommandIO } from '../types.js';

// We need access to the command registry, but can't import it directly
// due to circular deps. The caller will inject it.
let commandRegistry: Record<string, CommandHandler> | null = null;

export function setXargsCommandRegistry(registry: Record<string, CommandHandler>): void {
    commandRegistry = registry;
}

const argSpecs = {
    nullSep: { short: '0', desc: 'NUL-separated input' },
    delimiter: { short: 'd', value: true, desc: 'Input delimiter' },
    replace: { short: 'I', value: true, desc: 'Replace string' },
    maxArgs: { short: 'n', value: true, desc: 'Max args per command' },
    trace: { short: 't', desc: 'Print commands' },
    noRunIfEmpty: { short: 'r', desc: 'Skip if no input' },
    maxLines: { short: 'L', value: true, desc: 'Max lines per command' },
    parallel: { short: 'P', value: true, desc: 'Max parallel processes' },
};

type XargsOptions = {
    nullSep: boolean;
    delimiter: string | null;
    replace: string | null;
    maxArgs: number | null;
    trace: boolean;
    noRunIfEmpty: boolean;
    maxLines: number | null;
    parallel: number;
};

/**
 * Split input into items based on options
 */
function splitInput(input: string, options: XargsOptions): string[] {
    if (options.nullSep) {
        return input.split('\0').filter(s => s.length > 0);
    }

    if (options.delimiter) {
        return input.split(options.delimiter).filter(s => s.length > 0);
    }

    // -L option: split by lines, preserving words within each line
    if (options.maxLines !== null) {
        return input.split('\n').filter(s => s.trim().length > 0).map(s => s.trim());
    }

    // Default: split on whitespace, respecting quotes
    const items: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    let escape = false;

    for (const char of input) {
        if (escape) {
            current += char;
            escape = false;
            continue;
        }

        if (char === '\\') {
            escape = true;
            continue;
        }

        if ((char === '"' || char === "'") && !inQuote) {
            inQuote = char;
            continue;
        }

        if (char === inQuote) {
            inQuote = null;
            continue;
        }

        if (!inQuote && /\s/.test(char)) {
            if (current) {
                items.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (current) {
        items.push(current);
    }

    return items;
}

/**
 * Group items into batches based on options
 */
function batchItems(
    items: string[],
    options: XargsOptions
): string[][] {
    // -I implies -n 1
    if (options.replace) {
        return items.map(item => [item]);
    }

    const batchSize = options.maxArgs ?? options.maxLines ?? items.length;

    if (batchSize <= 0 || batchSize >= items.length) {
        return [items];
    }

    const batches: string[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
        batches.push(items.slice(i, i + batchSize));
    }

    return batches;
}

/**
 * Execute a single command invocation
 */
async function executeCommand(
    session: Session,
    fs: FS | null,
    cmdName: string,
    cmdArgs: string[],
    batch: string[],
    options: XargsOptions,
    io: CommandIO
): Promise<number> {
    let fullArgs: string[];

    if (options.replace) {
        // Replace placeholder with each item
        const item = batch[0];
        fullArgs = cmdArgs.map(arg =>
            arg.includes(options.replace!) ? arg.replace(options.replace!, item) : arg
        );
    } else {
        // Append items to args
        fullArgs = [...cmdArgs, ...batch];
    }

    // Trace mode
    if (options.trace) {
        io.stderr.write(`+ ${cmdName} ${fullArgs.join(' ')}\n`);
    }

    if (!commandRegistry) {
        io.stderr.write('xargs: command registry not initialized\n');
        return 1;
    }

    const handler = commandRegistry[cmdName];
    if (!handler) {
        io.stderr.write(`xargs: ${cmdName}: command not found\n`);
        return 127;
    }

    const childIO: CommandIO = {
        stdin: new PassThrough(),
        stdout: io.stdout,
        stderr: io.stderr,
        signal: io.signal,
    };
    childIO.stdin.end();

    try {
        return await handler(session, fs, fullArgs, childIO);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        io.stderr.write(`xargs: ${cmdName}: ${message}\n`);
        return 1;
    }
}

/**
 * Execute batches with parallelism
 */
async function executeBatches(
    session: Session,
    fs: FS | null,
    cmdName: string,
    cmdArgs: string[],
    batches: string[][],
    options: XargsOptions,
    io: CommandIO
): Promise<number> {
    let lastExitCode = 0;
    const maxParallel = Math.max(1, options.parallel);

    if (maxParallel === 1) {
        // Sequential execution
        for (const batch of batches) {
            if (io.signal?.aborted) return 130;

            const code = await executeCommand(
                session, fs, cmdName, cmdArgs, batch, options, io
            );
            if (code !== 0) lastExitCode = code;
        }
    } else {
        // Parallel execution
        let i = 0;
        while (i < batches.length) {
            if (io.signal?.aborted) return 130;

            const chunk = batches.slice(i, i + maxParallel);
            const promises = chunk.map(batch =>
                executeCommand(session, fs, cmdName, cmdArgs, batch, options, io)
            );

            const results = await Promise.all(promises);
            for (const code of results) {
                if (code !== 0) lastExitCode = code;
            }

            i += maxParallel;
        }
    }

    return lastExitCode;
}

export const xargs: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`xargs: ${err}\n`);
        }
        return 1;
    }

    const options: XargsOptions = {
        nullSep: Boolean(parsed.flags.nullSep),
        delimiter: typeof parsed.flags.delimiter === 'string' ? parsed.flags.delimiter : null,
        replace: typeof parsed.flags.replace === 'string' ? parsed.flags.replace : null,
        maxArgs: typeof parsed.flags.maxArgs === 'string' ? parseInt(parsed.flags.maxArgs, 10) : null,
        trace: Boolean(parsed.flags.trace),
        noRunIfEmpty: Boolean(parsed.flags.noRunIfEmpty),
        maxLines: typeof parsed.flags.maxLines === 'string' ? parseInt(parsed.flags.maxLines, 10) : null,
        parallel: typeof parsed.flags.parallel === 'string' ? parseInt(parsed.flags.parallel, 10) : 1,
    };

    // Default to 'echo' if no command specified (standard xargs behavior)
    const cmdName = parsed.positional[0] || 'echo';
    const cmdArgs = parsed.positional.slice(1);

    // Read all stdin
    let buffer = '';
    for await (const chunk of io.stdin) {
        buffer += chunk.toString();
    }

    // Split into items
    const items = splitInput(buffer, options);

    if (items.length === 0) {
        if (options.noRunIfEmpty) {
            return 0;
        }
        // Still run command with no args (default xargs behavior)
        return executeCommand(session, fs, cmdName, cmdArgs, [], options, io);
    }

    // Batch items
    const batches = batchItems(items, options);

    // Execute
    return executeBatches(session, fs, cmdName, cmdArgs, batches, options, io);
};
