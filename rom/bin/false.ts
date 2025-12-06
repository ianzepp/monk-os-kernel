/**
 * false - Exit with failure status
 *
 * POSIX-compatible utility that always exits with code 1.
 * Used for shell scripting and testing.
 */

import { exit } from '@rom/lib/process/index.js';

exit(1);
