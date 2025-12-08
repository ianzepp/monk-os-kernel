/**
 * OS Public API
 *
 * Main entry point for external applications consuming Monk OS.
 *
 * Class Hierarchy:
 *   BaseOS (abstract) - shared functionality
 *   ├── OS - production implementation (full boot)
 *   └── TestOS - testing implementation (flexible partial boot)
 */

// Base class
export { BaseOS } from './base.js';

// Production class
export { OS } from './os.js';

// Testing class
export { TestOS, loadVfsSchema, loadVfsSchemaWithFileDevice } from './test.js';
export type { TestBootOpts, TestLayer } from './test.js';

// Stack factory (for tests - will be deprecated in favor of TestOS)
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
