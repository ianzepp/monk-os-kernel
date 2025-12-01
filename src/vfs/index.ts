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
export type { Model, ModelStat, FieldDef, MessageModel } from '@src/vfs/model.js';
export { PosixModel } from '@src/vfs/model.js';
export type { FileHandle, OpenFlags, SeekWhence } from '@src/vfs/handle.js';
export type { ACL, Grant } from '@src/vfs/acl.js';

// Message-based interface
export type { Message, Response } from '@src/vfs/message.js';
export { respond } from '@src/vfs/message.js';

// VFS class
export { VFS } from '@src/vfs/vfs.js';
export type { MountOptions, MountInfo } from '@src/vfs/vfs.js';

// Built-in models
export { FileModel } from '@src/vfs/models/file.js';
export { FolderModel } from '@src/vfs/models/folder.js';
export { DeviceModel, initStandardDevices } from '@src/vfs/models/device.js';
export { LinkModel } from '@src/vfs/models/link.js';
export { ProcModel, ProcessRegistry, createProcessProc } from '@src/vfs/models/proc.js';
export type { ProcessState } from '@src/vfs/models/proc.js';

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
} from '@src/hal/index.js';
