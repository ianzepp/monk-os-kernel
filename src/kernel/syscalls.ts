/**
 * Syscall Dispatch
 *
 * Routes syscall requests to appropriate handlers.
 */

// Re-export types
export type { SyscallHandler, SyscallRegistry, ProcessPortMessage } from './syscalls/types.js';

// Re-export dispatcher
export { SyscallDispatcher } from './syscalls/dispatcher.js';

// Re-export syscall creators
export { createFileSyscalls } from './syscalls/file.js';
export { createMiscSyscalls } from './syscalls/misc.js';
export { createNetworkSyscalls } from './syscalls/network.js';
export { createChannelSyscalls } from './syscalls/channel.js';

// Re-export registration function
export { registerSyscalls } from './syscalls/index.js';
