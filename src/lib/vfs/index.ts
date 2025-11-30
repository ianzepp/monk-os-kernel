/**
 * Virtual File System (VFS)
 *
 * Monk OS storage layer implementing Plan 9 + BeOS philosophies:
 * - Everything is a file
 * - Files are database rows with queryable attributes
 * - UUID-first identity
 *
 * The VFS sits between processes and the HAL, providing:
 * - Unified namespace via mount table
 * - Path resolution to Models
 * - Access control enforcement
 * - Quota tracking
 */

// Core interfaces
export type { Model, ModelStat, FieldDef } from './model.js';
export type { FileHandle, OpenFlags, SeekWhence } from './handle.js';
export type { ACL, Grant } from './acl.js';

// VFS class
export { VFS } from './vfs.js';
export type { MountOptions, MountInfo } from './vfs.js';

// Built-in models
export { FileModel } from './models/file.js';
export { FolderModel } from './models/folder.js';

// Errors (re-export relevant HAL errors + VFS-specific)
export {
    ENOENT,
    EEXIST,
    ENOTDIR,
    EISDIR,
    EACCES,
    EPERM,
    EBADF,
    EINVAL,
    ENOSPC,
    ENOTEMPTY,
} from '../hal/index.js';
