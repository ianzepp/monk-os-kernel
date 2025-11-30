/**
 * keys remove - Remove a key
 *
 * Usage:
 *   keys remove <identifier>
 *   keys remove <id>
 *   keys rm SHA256:...
 *   keys rm mk_live_...
 */

import { runTransaction } from '@src/lib/transaction.js';
import { removeKey } from '@src/lib/credentials/index.js';
import type { CommandHandler } from '../shared.js';

export const remove: CommandHandler = async (session, fs, args, io) => {
    if (!session.systemInit) {
        io.stderr.write('keys: not authenticated\n');
        return 1;
    }

    const identifier = args[0];

    if (!identifier) {
        io.stderr.write('keys remove: missing identifier\n');
        io.stderr.write('Usage: keys remove <identifier>\n');
        io.stderr.write('Use "keys list" to see registered keys.\n');
        return 1;
    }

    try {
        const key = await runTransaction(session.systemInit, async (system) => {
            return removeKey(system, session.systemInit!.userId, identifier);
        });

        if (!key) {
            io.stderr.write(`keys remove: key not found: ${identifier}\n`);
            io.stderr.write('Use "keys list" to see registered keys.\n');
            return 1;
        }

        const keyType = key.type === 'ssh_pubkey' ? 'SSH' : 'API';
        io.stdout.write(`${keyType} key removed:\n`);
        io.stdout.write(`  ${key.identifier}\n`);
        if (key.name) {
            io.stdout.write(`  Name: ${key.name}\n`);
        }

        return 0;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        io.stderr.write(`keys remove: ${message}\n`);
        return 1;
    }
};
