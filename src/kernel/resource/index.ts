/**
 * Resource Module
 *
 * Re-exports all port types and implementations.
 */

// Types
export type { Port, PortMessage, PortType, UdpSocketOpts } from './types.js';

// Port implementations
export { ListenerPort } from './listener-port.js';
export { WatchPort, type VfsWatchEvent } from './watch-port.js';
export { UdpPort } from './udp-port.js';
export { PubsubPort, matchTopic } from './pubsub-port.js';

// Message pipe
export { MessagePipe, createMessagePipe, type PipeEnd } from './message-pipe.js';
