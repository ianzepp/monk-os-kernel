/**
 * Monk OS
 *
 * Main package entry point for external consumers.
 *
 * @example
 * ```typescript
 * import { OS } from '@monk-api/os';
 *
 * const os = new OS();
 * await os.boot();
 * ```
 */

// OS public API
export {
    OS,
    type StorageConfig,
    type OSConfig,
    type BootOpts,
    type MountOpts,
    type Stat,
} from './os/index.js';
