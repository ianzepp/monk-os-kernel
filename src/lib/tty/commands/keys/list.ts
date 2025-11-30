/**
 * keys list - List registered keys
 *
 * Usage:
 *   keys list
 *   keys list --type ssh
 *   keys list --type api
 */

import { runTransaction } from '@src/lib/transaction.js';
import { listKeys, type KeyType } from '@src/lib/credentials/index.js';
import type { CommandHandler } from '../shared.js';

export const list: CommandHandler = async (session, fs, args, io) => {
    if (!session.systemInit) {
        io.stderr.write('keys: not authenticated\n');
        return 1;
    }

    // Parse arguments
    let type: KeyType | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if ((arg === '--type' || arg === '-t') && args[i + 1]) {
            const typeArg = args[++i];
            if (typeArg === 'ssh') {
                type = 'ssh_pubkey';
            } else if (typeArg === 'api') {
                type = 'api_key';
            } else {
                io.stderr.write(`keys list: unknown type '${typeArg}'\n`);
                io.stderr.write('Valid types: ssh, api\n');
                return 1;
            }
        }
    }

    try {
        const keys = await runTransaction(session.systemInit, async (system) => {
            return listKeys(system, session.systemInit!.userId, type);
        });

        if (keys.length === 0) {
            io.stdout.write('No keys registered.\n');
            io.stdout.write('Use "keys add ssh <key>" or "keys add api" to add a key.\n');
            return 0;
        }

        io.stdout.write(`${keys.length} key(s):\n\n`);

        for (const key of keys) {
            const name = key.name || '(unnamed)';
            const keyType = key.type === 'ssh_pubkey' ? 'SSH' : 'API';
            const createdAt = key.created_at.toISOString().slice(0, 10);

            io.stdout.write(`  [${keyType}] ${key.identifier}\n`);
            io.stdout.write(`    Name:    ${name}\n`);
            if (key.algorithm) {
                io.stdout.write(`    Algo:    ${key.algorithm}\n`);
            }
            io.stdout.write(`    Added:   ${createdAt}\n`);
            if (key.last_used_at) {
                io.stdout.write(`    Used:    ${key.last_used_at.toISOString().slice(0, 10)}\n`);
            }
            if (key.expires_at) {
                io.stdout.write(`    Expires: ${key.expires_at.toISOString().slice(0, 10)}\n`);
            }
            io.stdout.write('\n');
        }

        return 0;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        io.stderr.write(`keys list: ${message}\n`);
        return 1;
    }
};
