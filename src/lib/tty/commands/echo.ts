/**
 * echo - Output text
 */

import type { CommandHandler } from './shared.js';

export const echo: CommandHandler = async (_session, _fs, args, io) => {
    io.stdout.write(args.join(' ') + '\n');
    return 0;
};
