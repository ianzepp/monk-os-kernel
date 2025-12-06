/**
 * true - Exit with success status
 *
 * POSIX-compatible utility that always exits with code 0.
 * Used for shell scripting and testing.
 */

import { exit } from '@rom/lib/process/index.js';

exit(0);
