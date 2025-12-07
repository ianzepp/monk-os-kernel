/**
 * Router Module - Syscall routing and streaming layer
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Router layer sits between userland processes and the kernel. It handles:
 * - Message parsing and routing (syscall/ping/cancel)
 * - Backpressure via StreamController
 * - Error boundary (exceptions → error responses)
 * - Response streaming to processes
 *
 * The kernel implements KernelOps to provide syscall behavior. The router
 * dispatches to kernel methods and manages the streaming protocol.
 *
 * @module router
 */

// Router class
export { Router } from './router.js';
export type { ProcessLookup, ResponseSender, PrintkFn } from './router.js';

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
export type {
    RouterDeps,
    ProcessContext,
    SyscallRequest,
    StreamPingMessage,
    StreamCancelMessage,
    KernelMessage,
    OpenFlags,
    SpawnOpts,
    KernelOps,
    SyscallName,
} from './types.js';
