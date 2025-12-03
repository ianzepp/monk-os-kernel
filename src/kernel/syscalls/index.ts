/**
 * Syscalls Module - Entry point for kernel syscall system
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module serves as the main export point for Monk OS's syscall infrastructure.
 * It re-exports all syscall types, the dispatcher, and syscall creator functions
 * that return handler registries for different subsystems (file, network, channel,
 * misc operations).
 *
 * The syscall system follows a modular design where handlers are grouped by domain
 * (file operations, network operations, etc.) and registered with the dispatcher
 * during kernel initialization. This separation enables:
 * - Clear ownership boundaries (VFS owns file syscalls, NetStack owns network syscalls)
 * - Testability (each subsystem's syscalls can be tested independently)
 * - Extensibility (new syscall domains can be added without modifying existing code)
 *
 * SyscallDispatcher routes incoming syscall requests from processes to registered
 * handlers. It validates process state, marshals arguments, invokes handlers, and
 * streams responses back to the calling process's worker thread.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All exported syscall creators return valid SyscallRegistry objects
 * INV-2: SyscallDispatcher is initialized before any syscall can be invoked
 * INV-3: Handler names in registries must be unique across all subsystems
 * INV-4: All handlers conform to SyscallHandler signature (Process, ...args) => AsyncIterable<Response>
 *
 * CONCURRENCY MODEL
 * =================
 * This module itself has no concurrency concerns - it only performs static exports.
 * Concurrency is handled at the dispatcher and handler levels:
 * - Dispatcher runs in kernel's main async context
 * - Multiple syscalls can execute concurrently from different processes
 * - Handlers must check process state after await points (see types.ts RC-1)
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * N/A - This is a pure export module with no runtime state or async operations.
 * Race condition handling is documented in:
 * - types.ts: Handler execution model
 * - dispatcher.ts: Request routing and response delivery
 * - Individual handler modules (file.ts, network.ts, etc.)
 *
 * MEMORY MANAGEMENT
 * =================
 * - Exported types and functions are stateless
 * - No cleanup required - module is loaded once at kernel startup
 * - Handler registries are long-lived (kernel lifetime) but small
 *
 * @module kernel/syscalls
 */

// =============================================================================
// TYPE EXPORTS
// =============================================================================

/**
 * Core syscall types and interfaces.
 *
 * WHY: These types are used throughout the kernel for syscall registration,
 * dispatch, and port-based I/O. Exporting them here provides a single
 * import location for all syscall-related types.
 */
export type { SyscallHandler, SyscallRegistry, ProcessPortMessage } from './types.js';

// =============================================================================
// DISPATCHER EXPORT
// =============================================================================

/**
 * Syscall dispatcher for routing requests to handlers.
 *
 * WHY: The dispatcher is the kernel's main entry point for syscall execution.
 * Exported here so kernel initialization code can create and configure a
 * dispatcher instance with all registered handlers.
 */
export { SyscallDispatcher } from './dispatcher.js';

// =============================================================================
// SYSCALL CREATOR EXPORTS
// =============================================================================

/**
 * File system syscall handlers.
 *
 * WHY: File operations (open, read, write, close, stat, etc.) are grouped
 * together because they all interact with the VFS subsystem and share common
 * permissions checks and handle management.
 *
 * USAGE: Kernel calls createFileSyscalls(deps) and registers handlers:
 * - fs:open, fs:read, fs:write, fs:close
 * - fs:stat, fs:readdir, fs:mkdir, fs:unlink
 * - fs:seek, fs:tell, fs:sync
 */
export { createFileSyscalls } from './file.js';

/**
 * Miscellaneous syscall handlers.
 *
 * WHY: General-purpose syscalls that don't fit into file/network/channel
 * domains. Includes process management (getpid, exit), time (clock), and
 * other kernel utilities.
 *
 * USAGE: Kernel calls createMiscSyscalls(deps) and registers handlers:
 * - misc:getpid, misc:exit
 * - misc:clock, misc:sleep
 * - misc:log, misc:debug
 */
export { createMiscSyscalls } from './misc.js';

/**
 * Network syscall handlers.
 *
 * WHY: Network operations (tcp, udp, dns) are isolated from file operations
 * because they interact with the NetStack subsystem and have different
 * permission models (network ACLs vs file permissions).
 *
 * USAGE: Kernel calls createNetworkSyscalls(deps) and registers handlers:
 * - net:tcp:connect, net:tcp:listen, net:tcp:accept
 * - net:udp:bind, net:udp:send, net:udp:recv
 * - net:dns:resolve, net:dns:reverse
 */
export { createNetworkSyscalls } from './network.js';

/**
 * Channel (IPC) syscall handlers.
 *
 * WHY: Inter-process communication channels are separate from network sockets
 * because they bypass network stack and provide process-local message passing
 * with different security semantics (process permissions vs network ACLs).
 *
 * USAGE: Kernel calls createChannelSyscalls(deps) and registers handlers:
 * - chan:create, chan:connect, chan:send, chan:recv
 * - chan:close, chan:accept
 */
export { createChannelSyscalls } from './channel.js';
