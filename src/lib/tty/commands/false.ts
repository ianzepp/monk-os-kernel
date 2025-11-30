/**
 * false - do nothing, unsuccessfully
 *
 * Usage:
 *   false
 *
 * Exit status is always 1.
 */

import type { CommandHandler } from './shared.js';

export const false_: CommandHandler = async () => {
    return 1;
};
