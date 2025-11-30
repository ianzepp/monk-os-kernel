/**
 * keys add - Add a new key
 *
 * Usage:
 *   keys add ssh <publickey>
 *   keys add ssh -n <name> <publickey>
 *   keys add api
 *   keys add api --name <name>
 *   keys add api --expires <date>
 *   cat ~/.ssh/id_ed25519.pub | keys add ssh
 */

import { runTransaction } from '@src/lib/transaction.js';
import { addSSHKey, addApiKey, formatKeyForDisplay } from '@src/lib/credentials/index.js';
import type { ApiKeyEnvironment } from '@src/lib/credentials/index.js';
import type { CommandHandler } from '../shared.js';

export const add: CommandHandler = async (session, fs, args, io) => {
    if (!session.systemInit) {
        io.stderr.write('keys: not authenticated\n');
        return 1;
    }

    const keyType = args[0];

    if (!keyType) {
        io.stderr.write('keys add: missing key type\n');
        io.stderr.write('Usage: keys add ssh <publickey>\n');
        io.stderr.write('       keys add api [--name <name>]\n');
        return 1;
    }

    if (keyType === 'ssh') {
        return addSSH(session, args.slice(1), io);
    } else if (keyType === 'api') {
        return addAPI(session, args.slice(1), io);
    } else {
        io.stderr.write(`keys add: unknown key type '${keyType}'\n`);
        io.stderr.write('Valid types: ssh, api\n');
        return 1;
    }
};

async function addSSH(session: any, args: string[], io: any): Promise<number> {
    // Parse arguments
    let name: string | undefined;
    let keyString: string | null = null;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-n' || arg === '--name') {
            name = args[++i];
        } else if (!arg.startsWith('-')) {
            // Collect remaining args as key (may have spaces in comment)
            keyString = args.slice(i).join(' ');
            break;
        }
    }

    // Read from stdin if no key provided
    if (!keyString) {
        const chunks: string[] = [];
        for await (const chunk of io.stdin) {
            chunks.push(chunk.toString());
        }
        keyString = chunks.join('').trim();
    }

    if (!keyString) {
        io.stderr.write('keys add ssh: missing public key\n');
        io.stderr.write('Usage: keys add ssh [-n name] <key>\n');
        io.stderr.write('   or: cat ~/.ssh/id_ed25519.pub | keys add ssh\n');
        return 1;
    }

    try {
        const key = await runTransaction(session.systemInit, async (system) => {
            return addSSHKey(system, session.systemInit!.userId, {
                publicKey: keyString!,
                name,
            });
        });

        io.stdout.write('SSH key added:\n');
        io.stdout.write(`  ${key.identifier}\n`);
        if (key.name) {
            io.stdout.write(`  Name: ${key.name}\n`);
        }
        io.stdout.write(`  Algorithm: ${key.algorithm}\n`);

        return 0;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        io.stderr.write(`keys add ssh: ${message}\n`);
        return 1;
    }
}

async function addAPI(session: any, args: string[], io: any): Promise<number> {
    // Parse arguments
    let name: string | undefined;
    let environment: ApiKeyEnvironment = 'live';
    let expiresAt: Date | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-n' || arg === '--name') {
            name = args[++i];
        } else if (arg === '-e' || arg === '--env') {
            const env = args[++i];
            if (env === 'live' || env === 'test' || env === 'dev') {
                environment = env;
            } else {
                io.stderr.write(`keys add api: invalid environment '${env}'\n`);
                io.stderr.write('Valid environments: live, test, dev\n');
                return 1;
            }
        } else if (arg === '--expires') {
            const dateStr = args[++i];
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) {
                io.stderr.write(`keys add api: invalid date '${dateStr}'\n`);
                return 1;
            }
            expiresAt = date;
        }
    }

    try {
        const key = await runTransaction(session.systemInit, async (system) => {
            return addApiKey(system, session.systemInit!.userId, {
                name,
                environment,
                expiresAt,
            });
        });

        io.stdout.write('API key created:\n');
        io.stdout.write(`  ${key.secret}\n`);
        io.stdout.write('\n');
        io.stdout.write('  IMPORTANT: Save this key now. It will not be shown again.\n');
        io.stdout.write('\n');
        if (key.name) {
            io.stdout.write(`  Name: ${key.name}\n`);
        }
        io.stdout.write(`  Prefix: ${key.identifier}\n`);
        if (key.expires_at) {
            io.stdout.write(`  Expires: ${key.expires_at.toISOString().slice(0, 10)}\n`);
        }

        return 0;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        io.stderr.write(`keys add api: ${message}\n`);
        return 1;
    }
}
