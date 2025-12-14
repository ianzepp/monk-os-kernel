/**
 * Stream Module - Backpressure and flow control
 *
 * Controller hierarchy:
 *   StreamController (base class)
 *   ├── SyscallController (kernel produces → userspace consumes)
 *   └── SigcallController (userspace produces → kernel consumes)
 *
 * @module dispatch/stream
 */

// Base class and error
export { StreamController, StallError } from './controller.js';

// Specialized controllers
export { SyscallController } from './syscall-controller.js';
export { SigcallController } from './sigcall-controller.js';

// Types
export type { StreamControllerDeps, StreamControllerOpts, StreamControllerConfig } from './types.js';

// Constants
export {
    STREAM_HIGH_WATER,
    STREAM_LOW_WATER,
    STREAM_PING_INTERVAL,
    STREAM_STALL_TIMEOUT,
} from './constants.js';
