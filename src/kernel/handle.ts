/**
 * Unified Handle Architecture
 *
 * All I/O primitives (files, sockets, pipes, ports, channels) are handles.
 * A single `send(handle, msg)` syscall dispatches to the handle type.
 *
 * Philosophy:
 * - Everything is a handle with send(Message) → AsyncIterable<Response>
 * - Handle types define supported operations
 * - Userspace API unchanged - this is kernel-internal unification
 *
 * Handle Types:
 * - file: VFS files, folders, devices
 * - socket: TCP connections
 * - pipe: In-memory pipes between processes
 * - port: Message-based I/O (listeners, watchers, pubsub)
 * - channel: Protocol-aware connections (HTTP, WebSocket, PostgreSQL)
 */

// Re-export types
export type { HandleType, Handle } from './handle/types.js';

// Re-export implementations
export { FileHandleAdapter } from './handle/file.js';
export { SocketHandleAdapter } from './handle/socket.js';
export { PipeHandleAdapter, type PipeEnd } from './handle/pipe.js';
export { PortHandleAdapter } from './handle/port.js';
export { ChannelHandleAdapter } from './handle/channel.js';
export { ProcessIOHandle } from './handle/process-io.js';
