/**
 * Resource
 *
 * Ports are message-based I/O channels for:
 * - TCP listeners (accept connections)
 * - UDP sockets (datagrams)
 * - File watchers
 * - Pub/sub messaging
 *
 * NOTE: The legacy Resource interface and FileResource/SocketResource/PipeResource
 * classes have been removed. Use Handle adapters from handle.ts instead.
 */

// Re-export types
export type { Port, PortMessage, PortType, UdpSocketOpts } from './resource/types.js';

// Re-export port implementations
export { ListenerPort } from './resource/listener-port.js';
export { WatchPort, type VfsWatchEvent } from './resource/watch-port.js';
export { UdpPort } from './resource/udp-port.js';
export { PubsubPort, matchTopic } from './resource/pubsub-port.js';

// Re-export message pipe
export { MessagePipe, createMessagePipe, type PipeEnd } from './resource/message-pipe.js';
