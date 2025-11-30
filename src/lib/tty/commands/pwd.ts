/**
 * pwd - Print working directory
 */

import type { CommandHandler } from './shared.js';

export const pwd: CommandHandler = async (session, _fs, _args, io) => {
    io.stdout.write(session.cwd + '\n');
    return 0;
};
