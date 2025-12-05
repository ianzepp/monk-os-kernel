/**
 * Virtual File System (VFS) - Public API exports
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The VFS is Monk OS's unified storage layer, implementing a combination of
 * Plan 9 and BeOS philosophies:
 *
 * - Everything is a file (processes, devices, network sockets)
 * - Files are database rows with queryable attributes
 * - UUID-first identity (paths are convenience, not identity)
 *
 * The VFS sits between processes and the Hardware Abstraction Layer (HAL):
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │                      User Processes                       │
 *   └───────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 *   ┌───────────────────────────────────────────────────────────┐
 *   │                          VFS                              │
 *   │  ┌─────────────┬─────────────┬─────────────┬───────────┐  │
 *   │  │ Mount Table │ Path Resolver│ ACL Engine  │ Quota Mgr │  │
 *   │  └─────────────┴─────────────┴─────────────┴───────────┘  │
 *   │  ┌─────────────────────────────────────────────────────┐  │
 *   │  │                      Models                         │  │
 *   │  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌────┐ ┌──────┐        │  │
 *   │  │  │ File │ │Folder│ │Device│ │Proc│ │ Link │        │  │
 *   │  │  └──────┘ └──────┘ └──────┘ └────┘ └──────┘        │  │
 *   │  └─────────────────────────────────────────────────────┘  │
 *   └───────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 *   ┌───────────────────────────────────────────────────────────┐
 *   │                          HAL                              │
 *   │        (Storage, Clock, Entropy, Network, etc.)           │
 *   └───────────────────────────────────────────────────────────┘
 *
 * COMPONENTS
 * ==========
 *
 * Core Interfaces:
 * - Model: Defines behavior for a class of files (file, folder, device, etc.)
 * - FileHandle: I/O interface for open files
 * - ACL: Access control lists for permission management
 *
 * Message System:
 * - Message/Response: Typed message definitions for VFS operations
 * - respond: Helper functions for creating response messages
 *
 * Built-in Models:
 * - FileModel: Standard files with content stored in blobs
 * - FolderModel: Directories containing other entities
 * - DeviceModel: Virtual devices (stdin, stdout, random, etc.)
 * - LinkModel: Symbolic links
 * - ProcModel: Process introspection (/proc filesystem)
 *
 * Error Types:
 * - POSIX-style error classes (ENOENT, EACCES, etc.)
 *
 * @module vfs
 */

// =============================================================================
// CORE INTERFACES
// =============================================================================

export type { Model, ModelStat, FieldDef, MessageModel } from '@src/vfs/model.js';
export { PosixModel } from '@src/vfs/model.js';
export type { FileHandle, OpenFlags, SeekWhence } from '@src/vfs/handle.js';
export type { ACL, Grant } from '@src/vfs/acl.js';

// =============================================================================
// MESSAGE SYSTEM
// =============================================================================

export type { Message, Response } from '@src/vfs/message.js';
export { respond } from '@src/vfs/message.js';

// =============================================================================
// VFS CLASS
// =============================================================================

export { VFS } from '@src/vfs/vfs.js';
export type { MountOptions, MountInfo } from '@src/vfs/vfs.js';

// =============================================================================
// BUILT-IN MODELS
// =============================================================================

export { FileModel } from '@src/vfs/models/file.js';
export { FolderModel } from '@src/vfs/models/folder.js';
export { DeviceModel, initStandardDevices } from '@src/vfs/models/device.js';
export { LinkModel } from '@src/vfs/models/link.js';
// ProcModel removed - /proc is now handled by ProcMount (see src/vfs/mounts/proc.ts)

// =============================================================================
// SYNTHETIC MOUNTS
// =============================================================================

export type { EntityMount, EntityMountOptions } from '@src/vfs/mounts/entity.js';

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * POSIX-style error classes.
 *
 * Re-exported from HAL for convenience. Each error has a 'code' property
 * matching the POSIX error name.
 */
export {
    ENOENT,     // No such file or directory
    EEXIST,     // File exists
    ENOTDIR,    // Not a directory
    EISDIR,     // Is a directory
    EACCES,     // Permission denied
    EPERM,      // Operation not permitted
    EBADF,      // Bad file descriptor
    EINVAL,     // Invalid argument
    ENOSPC,     // No space left on device
    ENOTEMPTY,  // Directory not empty
} from '@src/hal/index.js';
