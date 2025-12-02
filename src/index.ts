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
    FilesystemAPI,
    type StorageConfig,
    type OSConfig,
    type BootOpts,
    type MountOpts,
    type Stat,
    type FilesystemAPIHost,
} from './os/index.js';
