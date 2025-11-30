/**
 * source - Execute commands from a file
 *
 * Usage:
 *   source <file>
 *   . <file>
 *
 * Reads and executes commands from file in the current shell environment.
 * Variables set in the script affect the current session.
 *
 * Examples:
 *   source ~/.profile
 *   . /scripts/setup.sh
 */

import type { CommandHandler } from './shared.js';
import { resolvePath } from '../parser.js';
import { executeLine } from '../executor.js';

export const source: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('source: filesystem not available\n');
        return 1;
    }

    if (args.length === 0) {
        io.stderr.write('source: missing file operand\n');
        io.stderr.write('Usage: source <file>\n');
        return 1;
    }

    const filePath = resolvePath(session.cwd, args[0]);

    // Read script file
    let content: string;
    try {
        const buffer = await fs.read(filePath);
        content = buffer.toString();
    } catch {
        io.stderr.write(`source: ${args[0]}: No such file\n`);
        return 1;
    }

    // Execute each line using the main executor
    const lines = content.split('\n');
    let lastExitCode = 0;

    for (let i = 0; i < lines.length; i++) {
        // Check for abort signal
        if (io.signal?.aborted) {
            return 130;
        }

        const line = lines[i];
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        // Execute the line with full scripting support
        // Pass the existing fs to avoid nested transactions
        lastExitCode = await executeLine(session, trimmed, io, {
            fs,
            useTransaction: false,
        });
    }

    return lastExitCode;
};

// Alias for POSIX dot command
export const dot = source;

// No longer need setSourceCommandRegistry - executor handles everything
