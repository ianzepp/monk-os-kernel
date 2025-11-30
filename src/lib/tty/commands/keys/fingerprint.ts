/**
 * keys fingerprint - Show fingerprint of an SSH key without adding it
 *
 * Usage:
 *   keys fingerprint <key>
 *   keys fp <key>
 *   cat ~/.ssh/id_ed25519.pub | keys fingerprint
 */

import { parseSSHPublicKey } from '@src/lib/credentials/index.js';
import type { CommandHandler } from '../shared.js';

export const fingerprint: CommandHandler = async (session, fs, args, io) => {
    let keyString: string | null = null;

    // Get key from args
    if (args.length > 0 && !args[0].startsWith('-')) {
        keyString = args.join(' ');
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
        io.stderr.write('keys fingerprint: missing public key\n');
        io.stderr.write('Usage: keys fingerprint <key>\n');
        io.stderr.write('   or: cat ~/.ssh/id_ed25519.pub | keys fingerprint\n');
        return 1;
    }

    // Parse the key
    const parsed = parseSSHPublicKey(keyString);
    if (!parsed) {
        io.stderr.write('keys fingerprint: invalid SSH public key\n');
        io.stderr.write('Key should start with ssh-rsa, ssh-ed25519, or ecdsa-sha2-*\n');
        return 1;
    }

    io.stdout.write(`${parsed.fingerprint}\n`);
    io.stdout.write(`  Algorithm: ${parsed.algorithm}\n`);
    if (parsed.comment) {
        io.stdout.write(`  Comment:   ${parsed.comment}\n`);
    }

    return 0;
};
