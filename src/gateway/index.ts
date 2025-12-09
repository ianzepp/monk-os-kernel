/**
 * Gateway - External syscall interface
 *
 * Provides external applications access to Monk OS syscalls over TCP and WebSocket.
 * Each client connection gets an isolated virtual process.
 *
 * @module gateway
 */

export { Gateway, DEFAULT_GATEWAY_PORT, DEFAULT_WEBSOCKET_PORT } from './gateway.js';
