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
    PackageOpts,
    PackageSpec,
    PackageInfo,
} from './types.js';

// Sub-APIs (for advanced use / testing)
export { FilesystemAPI } from './fs.js';
export type { FilesystemAPIHost } from './fs.js';
export { PackageAPI } from './pkg.js';
export type { PackageAPIHost } from './pkg.js';
