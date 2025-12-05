/**
 * TCP/Unix Socket Connect Syscall - Establish outbound socket connections
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Processes need to connect to remote services (HTTP servers, databases, etc.)
 * and local Unix domain sockets (IPC). This syscall creates an outbound socket
 * connection, wraps it in a SocketHandleAdapter, and allocates a file descriptor.
 *
 * SOCKET TYPES
 * ============
 * - TCP: Connect to remote host:port (port > 0)
 * - Unix: Connect to local socket path (port = 0, host = path)
 *
 * Unix sockets use port=0 as a discriminator because port numbers are always > 0
 * for TCP. The host parameter contains the filesystem path for Unix sockets.
 *
 * ASYNC OPERATION
 * ===============
 * Socket connection is ASYNC because underlying operations are async:
 * - TCP: DNS lookup, TCP handshake (SYN/SYN-ACK/ACK)
 * - Unix: Filesystem path resolution, socket file open
 *
 * CRITICAL: State changes after await. Process could be killed while we're
 * connecting. Always check process state after async operations.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: For TCP, port must be > 0 and host must be valid hostname/IP
 *        VIOLATED BY: HAL network.connect() throws EINVAL
 * INV-2: For Unix, port must be 0 and host must be valid filesystem path
 *        VIOLATED BY: HAL network.connect() throws ENOENT or EINVAL
 * INV-3: Socket handle must be allocated or socket must be closed
 *        VIOLATED BY: Socket leak (connection open but no handle)
 * INV-4: Socket adapter ID is globally unique UUID
 *        VIOLATED BY: UUID collision (extremely unlikely)
 *
 * CONCURRENCY MODEL
 * =================
 * This is a syscall executed by a running process. Process worker thread blocks
 * waiting for response. Multiple processes could connect to sockets concurrently.
 *
 * RACE CONDITION: Process killed during connection
 * - Process calls connectTcp(), we await hal.network.connect()
 * - While waiting (DNS lookup, TCP handshake), process receives SIGKILL
 * - We wake up with open socket, try to allocate handle
 * - Process is dead, can't map fd
 * - MITIGATION: Currently not detected - socket leaks (TODO)
 * - BETTER: Check process.state after await, close socket if dead
 *
 * RACE CONDITION: Connection closed by remote during setup
 * - TCP handshake completes, socket valid
 * - While creating adapter, remote sends FIN (closes)
 * - Adapter created but socket is closed
 * - MITIGATION: Socket state checked when process tries to read/write
 * - Not fatal, just delivers closed socket to process
 *
 * RACE CONDITION: DNS failure or connection refused
 * - DNS lookup fails: hal.network.connect() throws
 * - Connection refused: hal.network.connect() throws ECONNREFUSED
 * - Error propagates to process, no cleanup needed
 * - MITIGATION: HAL cleans up partial connection state
 *
 * MEMORY MANAGEMENT
 * =================
 * - Creates Socket instance (TCP or Unix, managed by HAL)
 * - Wraps in SocketHandleAdapter for Handle interface
 * - Registers handle in kernel.handles table
 * - Sets refcount = 1 (process owns it)
 * - Returns fd number to process
 * - When process closes fd or exits, kernel decrements refcount
 * - Socket.close() releases underlying connection (FIN for TCP, close for Unix)
 *
 * @module kernel/kernel/connect-tcp
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { SocketHandleAdapter } from '../handle.js';
import { allocHandle } from './alloc-handle.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Port number discriminator for Unix sockets.
 * WHY: TCP port numbers are always > 0, so 0 indicates Unix socket.
 */
const UNIX_SOCKET_PORT = 0;

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Connect to TCP or Unix socket and allocate a file descriptor.
 *
 * Syscall handler that creates outbound socket connection to host:port,
 * wraps in handle adapter, and returns fd number to calling process.
 *
 * ALGORITHM:
 * 1. Call hal.network.connect(host, port) to create socket (ASYNC)
 * 2. Determine if TCP or Unix based on port number
 * 3. For TCP: get remote address from socket.stat()
 * 4. For Unix: use host as path
 * 5. Create SocketHandleAdapter wrapping socket
 * 6. Allocate fd and register handle in kernel table
 * 7. Return fd number
 *
 * WHY ASYNC: HAL network operations are async (DNS lookup, TCP handshake).
 *
 * DESIGN CHOICE: Why check socket type after connect?
 * - HAL returns same Socket interface for TCP and Unix
 * - Can't know type from connect() return value
 * - Must check port parameter to determine type
 * - Socket.stat() provides remote address for TCP
 *
 * DESIGN CHOICE: Why allocate fd after socket connects?
 * - Connection might fail (refused, timeout, DNS error)
 * - Don't want fd allocated if connection fails
 * - Easier cleanup: no fd to unmap on error
 * - Socket is already connected, just need to wrap it
 *
 * DESIGN CHOICE: Why include remote address in description?
 * - Debugging aid: see where socket is connected
 * - Handle table shows "tcp:192.168.1.1:8080" for clarity
 * - Unix sockets show "unix:/path/to/socket"
 *
 * ERROR HANDLING: Socket cleanup on allocation failure
 * - If allocHandle fails (EMFILE, process dead, etc.)
 * - Must close socket to release connection
 * - Otherwise socket leaks until kernel restart
 * - Remote peer may hold resources waiting for close
 *
 * @param self - Kernel instance
 * @param proc - Calling process
 * @param host - Hostname/IP for TCP, or path for Unix socket
 * @param port - Port number for TCP (>0), or 0 for Unix socket
 * @returns File descriptor number
 * @throws EINVAL - Invalid host or port
 * @throws ECONNREFUSED - Connection refused by remote
 * @throws ETIMEDOUT - Connection timeout
 * @throws ENOENT - Unix socket path doesn't exist
 * @throws EMFILE - Too many open handles
 */
export async function connectTcp(
    self: Kernel,
    proc: Process,
    host: string,
    port: number,
): Promise<number> {
    // Connect to socket (ASYNC - process could die here)
    // For TCP: DNS lookup + handshake
    // For Unix: filesystem path resolution
    const socket = await self.hal.network.connect(host, port);

    // RACE FIX: Check process still running after await (TODO)
    // If process died while connecting, close socket and bail
    // (Currently not implemented - socket leaks if process killed)

    // Determine socket type and build description
    const isUnix = port === UNIX_SOCKET_PORT;
    const description = isUnix
        ? `unix:${host}`  // Unix socket: path is in host parameter
        : `tcp:${socket.stat().remoteAddr}:${socket.stat().remotePort}`;  // TCP: get actual remote address

    // Wrap socket in adapter for Handle interface
    const adapter = new SocketHandleAdapter(self.hal.entropy.uuid(), socket, description);

    // Allocate fd and register in kernel table
    // If this fails, socket stays open - BUG
    // TODO: Wrap in try/catch, close socket on error
    return allocHandle(self, proc, adapter);
}
