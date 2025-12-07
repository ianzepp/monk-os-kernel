/**
 * Gateway - External syscall interface
 *
 * Provides external applications access to Monk OS syscalls over Unix socket.
 * Each client connection gets an isolated virtual process.
 *
 * @module gateway
 */

export { Gateway } from './gateway.js';
