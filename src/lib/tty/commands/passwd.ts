/**
 * passwd - Change user password
 *
 * Usage:
 *   passwd                              Interactive mode (prompts for password)
 *   passwd <username>                   Change another user's password (root only)
 *   echo "newpass" | passwd             Set password from stdin
 *
 * In interactive mode, the password is entered twice for confirmation
 * and is not echoed to the terminal.
 */

import type { CommandHandler } from './shared.js';
import type { Session, CommandIO } from '../types.js';
import { runTransaction } from '@src/lib/transaction.js';
import { hashPassword } from '@src/lib/credentials/index.js';
import { PassThrough } from 'node:stream';

export const passwd: CommandHandler = async (session, _fs, args, io) => {
    if (!session.systemInit) {
        io.stderr.write('passwd: not authenticated\n');
        return 1;
    }

    const isRoot = session.env['ACCESS'] === 'root';
    let targetUsername: string;
    let newPassword: string | null = null;

    // Parse arguments - only username is accepted now
    if (args.length === 0) {
        targetUsername = session.username;
    } else if (args.length === 1) {
        // passwd <username> - change another user's password
        targetUsername = args[0];
    } else {
        io.stderr.write('Usage: passwd [username]\n');
        return 1;
    }

    const isChangingSelf = targetUsername === session.username;

    // Non-root users can only change their own password
    if (!isChangingSelf && !isRoot) {
        io.stderr.write('passwd: permission denied (only root can change other users)\n');
        return 1;
    }

    // Check if we have piped input
    const hasStdinData = await hasData(io.stdin, 50);

    if (hasStdinData) {
        // Read password from stdin (non-interactive)
        const chunks: string[] = [];
        for await (const chunk of io.stdin) {
            chunks.push(chunk.toString());
        }
        newPassword = chunks.join('').trim();
    } else {
        // Interactive mode - prompt for password
        newPassword = await promptForPassword(io);
        if (newPassword === null) {
            return 1; // User cancelled or error
        }
    }

    if (!newPassword) {
        io.stderr.write('passwd: password cannot be empty\n');
        return 1;
    }

    if (newPassword.length < 4) {
        io.stderr.write('passwd: password too short (minimum 4 characters)\n');
        return 1;
    }

    try {
        // Get the target user by auth (login username)
        const targetUser = await runTransaction(session.systemInit, async (system) => {
            return system.database.selectOne('users', {
                where: { auth: targetUsername },
            });
        });

        if (!targetUser) {
            io.stderr.write(`passwd: user '${targetUsername}' does not exist\n`);
            return 1;
        }

        // Update the password
        await updatePassword(session, targetUser.id, newPassword);

        io.stdout.write(`passwd: password updated for ${targetUsername}\n`);
        return 0;
    } catch (err) {
        io.stderr.write(`passwd: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
};

/**
 * Prompt for password interactively with confirmation
 */
async function promptForPassword(io: CommandIO): Promise<string | null> {
    io.stdout.write('New password: ');

    const password1 = await readLine(io.stdin, io.signal);
    if (password1 === null) {
        io.stdout.write('\n');
        io.stderr.write('passwd: cancelled\n');
        return null;
    }

    io.stdout.write('Confirm password: ');

    const password2 = await readLine(io.stdin, io.signal);
    if (password2 === null) {
        io.stdout.write('\n');
        io.stderr.write('passwd: cancelled\n');
        return null;
    }

    if (password1 !== password2) {
        io.stderr.write('passwd: passwords do not match\n');
        return null;
    }

    return password1;
}

/**
 * Read a single line from stdin
 */
async function readLine(
    stdin: PassThrough,
    signal?: AbortSignal
): Promise<string | null> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(null);
            return;
        }

        let buffer = '';
        let resolved = false;

        const cleanup = () => {
            stdin.removeListener('data', onData);
            stdin.removeListener('end', onEnd);
            signal?.removeEventListener('abort', onAbort);
        };

        const onData = (chunk: Buffer | string) => {
            if (resolved) return;

            buffer += chunk.toString();
            const newlineIndex = buffer.indexOf('\n');

            if (newlineIndex !== -1) {
                resolved = true;
                cleanup();
                resolve(buffer.slice(0, newlineIndex));
            }
        };

        const onEnd = () => {
            if (resolved) return;
            resolved = true;
            cleanup();
            resolve(buffer.length > 0 ? buffer : null);
        };

        const onAbort = () => {
            if (resolved) return;
            resolved = true;
            cleanup();
            resolve(null);
        };

        stdin.on('data', onData);
        stdin.on('end', onEnd);
        signal?.addEventListener('abort', onAbort);
    });
}

/**
 * Check if stdin has data available (with timeout)
 */
async function hasData(stream: PassThrough, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        if (stream.readableLength > 0) {
            resolve(true);
            return;
        }

        if (stream.readableEnded) {
            resolve(false);
            return;
        }

        const timeout = setTimeout(() => {
            stream.removeListener('readable', onReadable);
            stream.removeListener('end', onEnd);
            resolve(false);
        }, timeoutMs);

        const onReadable = () => {
            clearTimeout(timeout);
            stream.removeListener('end', onEnd);
            resolve(true);
        };

        const onEnd = () => {
            clearTimeout(timeout);
            stream.removeListener('readable', onReadable);
            resolve(false);
        };

        stream.once('readable', onReadable);
        stream.once('end', onEnd);
    });
}

/**
 * Update password in credentials table
 */
async function updatePassword(
    session: Session,
    userId: string,
    newPassword: string
): Promise<void> {
    const hashedPassword = await hashPassword(newPassword);

    await runTransaction(session.systemInit!, async (system) => {
        // Check if password credential exists
        const existing = await system.database.execute(
            `SELECT id FROM credentials
             WHERE user_id = $1 AND type = 'password' AND deleted_at IS NULL
             LIMIT 1`,
            [userId]
        );

        if (existing.rows && existing.rows.length > 0) {
            // Update existing
            await system.database.execute(
                `UPDATE credentials
                 SET secret = $1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [hashedPassword, existing.rows[0].id]
            );
        } else {
            // Insert new
            const id = crypto.randomUUID();
            await system.database.execute(
                `INSERT INTO credentials (id, user_id, type, secret, created_at, updated_at)
                 VALUES ($1, $2, 'password', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [id, userId, hashedPassword]
            );
        }
    });
}
