/**
 * Handle Module - Kernel handle exports
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module serves as the central export point for all kernel handle types
 * and implementations. Handles are the kernel's abstraction for I/O resources,
 * similar to file descriptors in Unix. Each handle type (file, socket, port,
 * channel, process-io, console) implements the Handle interface and provides
 * specific I/O semantics.
 *
 * Handle types are adapters that bridge kernel abstractions (VFS, network,
 * IPC) to a uniform Message-based interface. Processes interact with handles
 * through message passing, and the kernel routes operations to the appropriate
 * backend implementation.
 *
 * The Handle abstraction enables:
 * - Uniform I/O interface across different resource types
 * - Capability-based security (handle = permission)
 * - Resource lifecycle management via reference counting
 * - I/O redirection and observation (ProcessIOHandle)
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All exported handle types implement the Handle interface
 * INV-2: Handle types are immutable once instantiated
 * INV-3: Each handle has a unique id for kernel tracking
 *
 * CONCURRENCY MODEL
 * =================
 * This module is purely declarative (type/function exports). No state,
 * no concurrency concerns. Individual handle implementations manage their
 * own concurrency (see their respective documentation).
 *
 * MEMORY MANAGEMENT
 * =================
 * This module has no memory management concerns. It only re-exports types
 * and classes. Callers are responsible for handle lifecycle management.
 *
 * @module kernel/handle
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Handle type discriminator.
 *
 * WHY: Enables type-safe discrimination in switch statements and type guards.
 */
export type { HandleType } from './types.js';

/**
 * Base Handle interface.
 *
 * WHY: Defines the contract all handle implementations must satisfy.
 * INVARIANT: All exported handle classes implement this interface.
 */
export type { Handle } from './types.js';

// =============================================================================
// HANDLE IMPLEMENTATIONS
// =============================================================================

/**
 * File handle adapter - bridges VFS FileHandle to kernel Handle.
 *
 * WHY: Provides file I/O operations (read, write, seek) via message interface.
 */
export { FileHandleAdapter } from './file.js';

/**
 * Socket handle adapter - bridges network sockets to kernel Handle.
 *
 * WHY: Provides network I/O operations (send, recv, connect) via message interface.
 */
export { SocketHandleAdapter } from './socket.js';

/**
 * Port handle adapter - bridges MessagePort to kernel Handle.
 *
 * WHY: Provides IPC via structured cloning and transferable objects.
 */
export { PortHandleAdapter } from './port.js';

/**
 * Channel handle adapter - bridges async channels to kernel Handle.
 *
 * WHY: Provides typed message passing between processes.
 */
export { ChannelHandleAdapter } from './channel.js';

/**
 * Process I/O handle - mediates stdin/stdout/stderr routing.
 *
 * WHY: Enables I/O redirection and tapping at kernel level.
 */
export { ProcessIOHandle } from './process-io.js';

/**
 * Console handle adapter - bridges console output to kernel Handle.
 *
 * WHY: Provides host console access for debugging and logging.
 */
export { ConsoleHandleAdapter } from './console.js';

// =============================================================================
// DEPRECATION NOTES
// =============================================================================

// Note: PipeHandleAdapter removed - use MessagePipe from resource/ instead
// WHY: MessagePipe provides better semantics for bidirectional communication
// and integrates with the resource model rather than being a standalone handle.
