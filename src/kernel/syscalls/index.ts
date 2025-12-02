/**
 * Syscalls Module
 *
 * Re-exports all syscall types and implementations.
 */

// Types
export type { SyscallHandler, SyscallRegistry, ProcessPortMessage } from './types.js';

// Dispatcher
export { SyscallDispatcher } from './dispatcher.js';

// Syscall creators
export { createFileSyscalls } from './file.js';
export { createMiscSyscalls } from './misc.js';
export { createNetworkSyscalls } from './network.js';
export { createChannelSyscalls } from './channel.js';
