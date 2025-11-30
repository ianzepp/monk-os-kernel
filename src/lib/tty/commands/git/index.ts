/**
 * git - Version control operations
 *
 * Usage:
 *   git <subcommand> [options] [args]
 *
 * Subcommands:
 *   clone <url> [dest]    Clone a repository
 *
 * Note: This is a simplified git for the virtual filesystem.
 * It downloads repository contents but does not track history.
 */

import type { CommandHandler } from '../shared.js';
import { clone } from './clone.js';

const subcommands: Record<string, CommandHandler> = {
    clone,
};

export const git: CommandHandler = async (session, fs, args, io) => {
    const subcommand = args[0];

    if (!subcommand) {
        io.stderr.write('usage: git <subcommand> [options] [args]\n');
        io.stderr.write('\n');
        io.stderr.write('Subcommands:\n');
        io.stderr.write('   clone     Clone a repository\n');
        return 1;
    }

    const handler = subcommands[subcommand];
    if (!handler) {
        io.stderr.write(`git: '${subcommand}' is not a git command\n`);
        io.stderr.write('\n');
        io.stderr.write('Available subcommands:\n');
        for (const name of Object.keys(subcommands)) {
            io.stderr.write(`   ${name}\n`);
        }
        return 1;
    }

    return handler(session, fs, args.slice(1), io);
};
