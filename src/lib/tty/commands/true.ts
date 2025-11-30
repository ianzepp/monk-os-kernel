/**
 * true - do nothing, successfully
 *
 * Usage:
 *   true
 *
 * Exit status is always 0.
 */

import type { CommandHandler } from './shared.js';

export const true_: CommandHandler = async () => {
    return 0;
};
