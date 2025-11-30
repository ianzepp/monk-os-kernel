/**
 * ssh-key - DEPRECATED: Use 'keys' command instead
 */

import type { CommandHandler } from './shared.js';

export const sshKey: CommandHandler = async (session, fs, args, io) => {
    io.stderr.write('ssh-key: This command has been replaced by "keys"\n');
    io.stderr.write('\n');
    io.stderr.write('Usage:\n');
    io.stderr.write('  keys list --type ssh      List SSH keys\n');
    io.stderr.write('  keys add ssh <key>        Add an SSH key\n');
    io.stderr.write('  keys remove <id>          Remove a key\n');
    io.stderr.write('  keys fingerprint <key>    Show key fingerprint\n');
    return 1;
};
