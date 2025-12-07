/**
 * Syscall Module - Exports for the syscall layer
 *
 * @module syscall
 */

// Main dispatcher
export { SyscallDispatcher } from './dispatcher.js';

// Stream module
export { StreamController, StallError } from './stream/index.js';
export type { StreamControllerDeps, StreamControllerOpts, StreamControllerConfig } from './stream/index.js';
export {
    STREAM_HIGH_WATER,
    STREAM_LOW_WATER,
    STREAM_PING_INTERVAL,
    STREAM_STALL_TIMEOUT,
} from './stream/index.js';

// Types
export type { Process, OpenFlags, SpawnOpts, ExitStatus, Response, Message, ProcessPortMessage } from './types.js';
export { respond, MAX_STREAM_ENTRIES, MAX_HANDLES, DEFAULT_CHUNK_SIZE } from './types.js';
