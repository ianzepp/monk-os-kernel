/**
 * OS Public API
 *
 * Main entry point for external applications consuming Monk OS.
 */

// Main class
export { OS } from './os.js';

// Stack factory (for tests and advanced use)
export { createOsStack } from './stack.js';
export type { OsStackOptions, OsStack } from './stack.js';

// Types
export type {
    StorageConfig,
    OSConfig,
    BootOpts,
    MountOpts,
    Stat,
} from './types.js';
