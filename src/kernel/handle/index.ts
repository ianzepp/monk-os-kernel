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
export { PortHandleAdapter } from './port.js';
export { ChannelHandleAdapter } from './channel.js';
export { ProcessIOHandle } from './process-io.js';

// Note: PipeHandleAdapter removed - use MessagePipe from resource/ instead
