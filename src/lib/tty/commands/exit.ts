/**
 * exit/logout/quit - End session and close connection
 */

import { saveHistory } from '../session-handler.js';
import { terminateDaemon } from '@src/lib/process.js';
import { autoCoalesce } from '../memory.js';
import type { CommandHandler } from './shared.js';

export const exit: CommandHandler = async (session, _fs, _args, io) => {
    // Auto-coalesce STM before logout
    await autoCoalesce(session, (msg) => io.stdout.write(msg));

    // Save command history
    await saveHistory(session);

    io.stdout.write('Goodbye!\n');

    // Terminate shell process
    if (session.pid) {
        try {
            await terminateDaemon(session.pid, 0);
        } catch {
            // Ignore termination errors
        }
    }

    // Run cleanup handlers
    for (const cleanup of session.cleanupHandlers) {
        try {
            cleanup();
        } catch {
            // Ignore cleanup errors
        }
    }
    session.cleanupHandlers = [];

    // Signal to close the connection
    session.shouldClose = true;
    return 0;
};

// Aliases
export const logout = exit;
export const quit = exit;
