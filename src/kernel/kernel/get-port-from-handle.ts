/**
 * Port Handle Unwrapping - Extract Port from handle
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Extracts the underlying Port object from a handle, verifying type safety.
 * Used by port syscalls (listen, recv, send) to access the message-based
 * port interface (TCP listeners, UDP sockets, file watchers, pubsub).
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: If handle exists and type='port', getPort() returns Port
 *        VIOLATED BY: PortHandleAdapter without valid port
 * INV-2: Type check prevents access to wrong handle types
 *        VIOLATED BY: Skipping type check, casting blindly
 * INV-3: Returns undefined for non-port handles (not error)
 *        VIOLATED BY: Throwing exception instead of undefined
 *
 * CONCURRENCY MODEL
 * =================
 * Single-threaded: All handle operations run in main kernel thread.
 * No async points, no race conditions.
 *
 * TYPE SAFETY
 * ===========
 * Handle system is polymorphic: Multiple handle types (file, socket, pipe,
 * port, channel) share the same fd namespace. Type checks ensure we only
 * extract ports from port handles.
 *
 * WHY return undefined instead of throwing:
 * Allows syscalls to distinguish "fd doesn't exist" from "fd is wrong type".
 * Caller can return appropriate error (EBADF vs EINVAL).
 *
 * PORT TYPES
 * ==========
 * tcp:listen - TCP listener port (accepts connections)
 * udp        - UDP socket port (send/recv datagrams)
 * watch      - File system watcher port (receive file events)
 * pubsub     - Topic-based messaging port (subscribe/publish)
 *
 * All ports implement: recv() → PortMessage, send(to, data), close()
 *
 * @module kernel/kernel/get-port-from-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Port } from '../resource.js';
import type { PortHandleAdapter } from '../handle.js';
import { getHandle } from './get-handle.js';

/**
 * Get port from a handle.
 *
 * ALGORITHM:
 * 1. Lookup handle by fd (using getHandle)
 * 2. Check if handle exists and type is 'port'
 * 3. Cast to PortHandleAdapter and extract port
 * 4. Return port or undefined
 *
 * WHY type check is critical:
 * Prevents accessing port-specific methods on file/socket handles.
 * Without this, syscalls would crash or corrupt memory.
 *
 * HANDLE TYPE HIERARCHY:
 * All handles implement: exec(msg) → AsyncIterable<Response>, close()
 * Port handles additionally provide: getPort() → Port
 * Port interface provides: recv(), send(to, data), close()
 *
 * TYPE CAST SAFETY:
 * TypeScript `as PortHandleAdapter` is safe because:
 * 1. We checked handle.type === 'port' first
 * 2. Only PortHandleAdapter instances return type='port'
 * 3. Cast is for accessing adapter-specific getPort() method
 *
 * USAGE PATTERN:
 * ```typescript
 * const port = getPortFromHandle(kernel, proc, fd);
 * if (!port) {
 *   throw new EINVAL('File descriptor is not a port');
 * }
 * // Now safe to call port-specific methods
 * const msg = await port.recv();
 * await port.send(msg.from, { type: 'ack' });
 * ```
 *
 * @param self - Kernel instance
 * @param proc - Process owning the fd
 * @param h - Handle number (fd) to unwrap
 * @returns Port object or undefined if not a port handle
 */
export function getPortFromHandle(
    self: Kernel,
    proc: Process,
    h: number,
): Port | undefined {
    // Lookup handle (returns undefined if fd doesn't exist)
    const handle = getHandle(self, proc, h);

    // Type check: Ensure handle is a port
    if (!handle || handle.type !== 'port') {
        return undefined;
    }

    // Safe cast: We verified type='port', so this must be PortHandleAdapter
    // Extract underlying Port object from adapter
    return (handle as PortHandleAdapter).getPort();
}
