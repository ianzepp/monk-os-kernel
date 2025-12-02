/**
 * Handle Module
 *
 * Re-exports all handle types and implementations.
 */

// Types
export type { HandleType, Handle } from './types.js';

// Implementations
export { FileHandleAdapter } from './file.js';
export { SocketHandleAdapter } from './socket.js';
export { PipeHandleAdapter, type PipeEnd } from './pipe.js';
export { PortHandleAdapter } from './port.js';
export { ChannelHandleAdapter } from './channel.js';
export { ProcessIOHandle } from './process-io.js';
export { PortSourceAdapter } from './port-source.js';
