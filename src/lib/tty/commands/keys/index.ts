/**
 * keys - Manage authentication keys and credentials
 *
 * Usage:
 *   keys <subcommand> [options] [args]
 *
 * Subcommands:
 *   list [--type <type>]     List registered keys
 *   add ssh <key>            Add an SSH public key
 *   add api [--name <name>]  Generate a new API key
 *   remove <id>              Remove a key by ID or identifier
 *   fingerprint <key>        Show fingerprint of an SSH key
 */

import type { CommandHandler } from '../shared.js';
import { list } from './list.js';
import { add } from './add.js';
import { remove } from './remove.js';
import { fingerprint } from './fingerprint.js';

const subcommands: Record<string, CommandHandler> = {
    list,
    ls: list,
    add,
    remove,
    rm: remove,
    fingerprint,
    fp: fingerprint,
};

export const keys: CommandHandler = async (session, fs, args, io) => {
    const subcommand = args[0];

    if (!subcommand) {
        io.stderr.write('usage: keys <subcommand> [options] [args]\n');
        io.stderr.write('\n');
        io.stderr.write('Subcommands:\n');
        io.stderr.write('   list [--type ssh|api]   List registered keys\n');
        io.stderr.write('   add ssh <key>           Add an SSH public key\n');
        io.stderr.write('   add api [--name <n>]    Generate a new API key\n');
        io.stderr.write('   remove <id>             Remove a key\n');
        io.stderr.write('   fingerprint <key>       Show SSH key fingerprint\n');
        return 1;
    }

    const handler = subcommands[subcommand];
    if (!handler) {
        io.stderr.write(`keys: '${subcommand}' is not a keys command\n`);
        io.stderr.write('\n');
        io.stderr.write('Available subcommands: list, add, remove, fingerprint\n');
        return 1;
    }

    return handler(session, fs, args.slice(1), io);
};
