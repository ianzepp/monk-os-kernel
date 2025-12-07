/**
 * Stream Module - Backpressure and flow control
 *
 * @module router/stream
 */

export { StreamController, StallError } from './controller.js';
export type { StreamControllerDeps, StreamControllerOpts, StreamControllerConfig } from './types.js';
export {
    STREAM_HIGH_WATER,
    STREAM_LOW_WATER,
    STREAM_PING_INTERVAL,
    STREAM_STALL_TIMEOUT,
} from './constants.js';
