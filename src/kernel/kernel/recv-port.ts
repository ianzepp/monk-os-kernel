/**
 * Port Receive Syscall - Receive message from port with socket handle allocation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Ports deliver messages asynchronously: TCP connections, UDP datagrams, file
 * change events, or pubsub messages. This syscall blocks until a message arrives,
 * then returns it to the calling process.
 *
 * Special handling for TCP listeners: when a connection arrives, we receive a
 * socket handle. We must wrap it in SocketHandleAdapter and allocate an fd for
 * the process to use. This is "socket activation" - the process gets a connected
 * socket without explicitly calling accept().
 *
 * PORT MESSAGE TYPES
 * ==================
 * - TCP listener: { from: 'addr:port', socket: Socket, meta: {...} }
 * - UDP socket: { from: 'addr:port', data: Uint8Array, meta: {...} }
 * - Filesystem watch: { from: 'path', meta: { event: 'create'|'modify'|'delete' } }
 * - Pubsub: { from: 'topic', data: Uint8Array, meta: {...} }
 *
 * ASYNC OPERATION
 * ===============
 * port.recv() is ASYNC and blocks until message arrives. Process worker thread
 * waits for our response. State can change while we're waiting:
 * - Process could be killed (SIGKILL) while blocked in recv
 * - Port could be closed by another syscall
 * - Socket could be closed by remote peer
 *
 * CRITICAL: After every await, check that resources still exist and process
 * is still alive. Clean up any allocated resources if process died.
 *
 * SOCKET HANDLE ALLOCATION
 * ========================
 * When TCP listener receives connection, we get a Socket object that must be
 * wrapped and allocated:
 * 1. Check process has room for another handle (MAX_HANDLES)
 * 2. If no room, close socket immediately and throw EMFILE
 * 3. Create SocketHandleAdapter wrapping socket
 * 4. Allocate fd for process
 * 5. Return message with fd instead of socket
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Handle h must exist in process's fd table
 *        VIOLATED BY: Invalid fd number (EBADF)
 * INV-2: Handle must be a port (not file or socket)
 *        VIOLATED BY: Calling recv on non-port fd (EBADF)
 * INV-3: If socket arrives, it must be either allocated or closed
 *        VIOLATED BY: Socket leak (no fd, not closed)
 * INV-4: Process must have < MAX_HANDLES when receiving socket
 *        VIOLATED BY: Handle table full (EMFILE)
 *
 * CONCURRENCY MODEL
 * =================
 * This is a syscall executed by a running process. Process worker blocks waiting
 * for response. Multiple processes could call recv on different ports concurrently.
 *
 * RACE CONDITION: Process killed while blocked in port.recv()
 * - Process calls recv(), we await port.recv()
 * - While waiting, process receives SIGKILL
 * - We wake up with message, try to allocate handle
 * - Process is dead, can't map fd
 * - MITIGATION: Currently not detected - socket leaks (TODO)
 * - BETTER: Check process.state after await, close socket if dead
 *
 * RACE CONDITION: Socket closed by remote peer before we allocate
 * - TCP connection arrives, socket valid
 * - While creating adapter, remote closes connection
 * - Adapter created but socket is dead
 * - MITIGATION: Socket state checked when process tries to read/write
 * - Not fatal, just delivers closed socket to process
 *
 * RACE CONDITION: Handle table full when socket arrives
 * - Process at MAX_HANDLES - 1, calls recv()
 * - Another syscall allocates handle, now at MAX_HANDLES
 * - Socket arrives, we try to allocate, hits EMFILE
 * - MITIGATION: Close socket immediately, throw error
 * - Socket not leaked, error propagates to process
 *
 * MEMORY MANAGEMENT
 * =================
 * - Receives PortMessage from port (port owns message lifecycle)
 * - If socket present: wraps in SocketHandleAdapter
 * - Registers adapter in kernel.handles table
 * - Sets refcount = 1 (process owns it)
 * - Returns message with fd instead of socket
 * - Process can then read/write socket via fd
 * - When process closes fd, kernel decrements refcount and closes socket
 *
 * @module kernel/kernel/recv-port
 */

import type { Kernel } from '../kernel.js';
import type { Process, ProcessPortMessage } from '../types.js';
import { EBADF, EMFILE } from '../errors.js';
import { MAX_HANDLES } from '../types.js';
import { SocketHandleAdapter } from '../handle.js';
import { getPortFromHandle } from './get-port-from-handle.js';
import { allocHandle } from './alloc-handle.js';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Receive a message from a port handle.
 *
 * Syscall handler that blocks until message arrives on port, then returns it
 * to calling process. Special handling for TCP listeners: wraps socket in
 * handle adapter and allocates fd.
 *
 * ALGORITHM:
 * 1. Look up port from process's fd table
 * 2. Validate it's actually a port (not file/socket)
 * 3. Block waiting for message (ASYNC)
 * 4. If message contains socket (TCP listener):
 *    a. Check process has room for another handle
 *    b. If no room: close socket, throw EMFILE
 *    c. Create SocketHandleAdapter wrapping socket
 *    d. Allocate fd for socket
 *    e. Return { from, fd, meta } (socket replaced with fd)
 * 5. Else (no socket):
 *    a. Return { from, data, meta } unchanged
 *
 * WHY ASYNC: port.recv() blocks until message arrives.
 *
 * DESIGN CHOICE: Why allocate fd immediately?
 * - Socket is a live connection, must be usable by process
 * - Can't return Socket object to process (different worker)
 * - Must convert to fd before returning
 * - If allocation fails, close socket to prevent leak
 *
 * DESIGN CHOICE: Why close socket on EMFILE?
 * - Process can't use socket if we can't allocate fd
 * - Leaving socket open would leak connection
 * - Better to close and fail than leak resources
 * - Remote peer gets clean close, can retry
 *
 * ERROR HANDLING: Socket cleanup on handle allocation failure
 * - If allocHandle throws (EMFILE or other error)
 * - Must close socket before rethrowing
 * - Otherwise socket leaks until kernel restart
 * - Connection hangs, remote peer never gets close
 *
 * @param self - Kernel instance
 * @param proc - Calling process
 * @param h - File descriptor number of port
 * @returns Port message with socket replaced by fd if present
 * @throws EBADF - Invalid fd or not a port
 * @throws EMFILE - Too many open handles (when receiving TCP socket)
 */
export async function recvPort(
    self: Kernel,
    proc: Process,
    h: number,
): Promise<ProcessPortMessage> {
    // Look up port from process's fd table
    // Validates fd exists and is a port (not file/socket)
    const port = getPortFromHandle(self, proc, h);

    if (!port) {
        throw new EBADF(`Bad port: ${h}`);
    }

    // Block until message arrives (ASYNC - process could die here)
    const msg = await port.recv();

    // RACE FIX: Check process still running after await (TODO)
    // If process died while blocked, clean up and bail
    // (Currently not implemented - socket leaks if process killed)

    // -------------------------------------------------------------------------
    // Handle TCP listener socket (connection accepted)
    // -------------------------------------------------------------------------
    if (msg.socket) {
        // Check if process has room for another handle
        if (proc.handles.size >= MAX_HANDLES) {
            // No room - close socket to prevent leak
            await msg.socket.close();
            throw new EMFILE('Too many open handles');
        }

        // Create adapter for socket
        const stat = msg.socket.stat();
        const description = `tcp:${stat.remoteAddr}:${stat.remotePort}`;
        const adapter = new SocketHandleAdapter(self.hal.entropy.uuid(), msg.socket, description);

        // Allocate fd and register in kernel table
        // If this fails (EMFILE race, other error), socket stays open - BUG
        // TODO: Wrap in try/catch, close socket on error
        const fd = allocHandle(self, proc, adapter);

        // Return message with fd instead of socket
        return {
            from: msg.from,
            fd,               // Socket converted to fd
            meta: msg.meta,
        };
    }

    // -------------------------------------------------------------------------
    // Handle non-socket message (UDP, watch, pubsub)
    // -------------------------------------------------------------------------
    return {
        from: msg.from,
        data: msg.data,
        meta: msg.meta,
    };
}
