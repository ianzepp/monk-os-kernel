/**
 * whoami - Display current user
 */

import type { CommandHandler } from './shared.js';

export const whoami: CommandHandler = async (session, _fs, _args, io) => {
    io.stdout.write(session.username + '\n');
    return 0;
};
