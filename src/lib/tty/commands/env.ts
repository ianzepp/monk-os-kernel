/**
 * env - Display environment variables
 */

import type { CommandHandler } from './shared.js';

export const env: CommandHandler = async (session, _fs, _args, io) => {
    for (const [key, value] of Object.entries(session.env)) {
        io.stdout.write(`${key}=${value}\n`);
    }
    return 0;
};
