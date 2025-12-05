/**
 * Channel Open Syscall - Open protocol-aware channel connections
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Channels provide protocol-aware I/O for external systems without exposing
 * wire formats to userland. Instead of raw sockets, processes get structured
 * message interfaces for HTTP, WebSocket, PostgreSQL, and SQLite.
 *
 * This syscall creates a channel connection to the specified URL using the
 * specified protocol, wraps it in a ChannelHandleAdapter, and allocates a
 * file descriptor for the calling process.
 *
 * SUPPORTED PROTOCOLS
 * ===================
 * - http/https: HTTP requests via fetch() (RESTful APIs)
 * - ws/wss: WebSocket bidirectional messaging
 * - postgres: PostgreSQL database connections via Bun.sql()
 * - sqlite: SQLite database connections (embedded)
 * - sse: Server-Sent Events (event streams)
 *
 * WHY CHANNELS INSTEAD OF SOCKETS?
 * =================================
 * - Abstraction: Process doesn't need to know HTTP wire format
 * - Security: Can't craft malformed protocol messages
 * - Simplicity: Send structured requests, get structured responses
 * - Portability: Same interface works across protocols
 *
 * Example: HTTP channel
 * - Process: send({ method: 'GET', path: '/' })
 * - Kernel: fetch(url + path), return { status, headers, body }
 * - No HTTP parsing in userland
 *
 * ASYNC OPERATION
 * ===============
 * Channel opening is ASYNC because underlying operations are async:
 * - HTTP: fetch() validates URL, may do DNS lookup
 * - WebSocket: Opens connection, waits for handshake
 * - PostgreSQL: Connects to database, authenticates
 * - SQLite: Opens database file, validates schema
 *
 * CRITICAL: State changes after await. Process could be killed while we're
 * opening the channel. Always check process state after async operations.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Protocol must be supported (http, https, ws, wss, postgres, sqlite, sse)
 *        VIOLATED BY: HAL channel.open() throws for unknown protocol
 * INV-2: URL must be valid for the protocol
 *        VIOLATED BY: HAL channel.open() throws EINVAL
 * INV-3: Channel handle must be allocated or channel must be closed
 *        VIOLATED BY: Channel leak (connection open but no handle)
 * INV-4: Channel ID is globally unique UUID
 *        VIOLATED BY: UUID collision (extremely unlikely)
 *
 * CONCURRENCY MODEL
 * =================
 * This is a syscall executed by a running process. Process worker thread blocks
 * waiting for response. Multiple processes could open channels concurrently.
 *
 * RACE CONDITION: Process killed during channel open
 * - Process calls openChannel(), we await hal.channel.open()
 * - While waiting, process receives SIGKILL
 * - We wake up with open channel, try to allocate handle
 * - Process is dead, can't map fd
 * - MITIGATION: Currently not detected - channel leaks (TODO)
 * - BETTER: Check process.state after await, close channel if dead
 *
 * RACE CONDITION: Connection closed by remote before we allocate
 * - Channel opens successfully
 * - While creating adapter, remote closes connection
 * - Adapter created but channel is dead
 * - MITIGATION: Channel state checked when process tries to use it
 * - Not fatal, just delivers closed channel to process
 *
 * MEMORY MANAGEMENT
 * =================
 * - Creates Channel instance (protocol-specific, managed by HAL)
 * - Wraps in ChannelHandleAdapter for Handle interface
 * - Registers handle in kernel.handles table
 * - Sets refcount = 1 (process owns it)
 * - Returns fd number to process
 * - When process closes fd or exits, kernel decrements refcount
 * - Channel.close() releases underlying connection
 *
 * @module kernel/kernel/open-channel
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { ChannelOpts } from '../../hal/index.js';
import { ChannelHandleAdapter } from '../handle.js';
import { allocHandle } from './alloc-handle.js';
import { printk } from './printk.js';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Open a protocol-aware channel and allocate a file descriptor.
 *
 * Syscall handler that creates channel connection to URL with specified protocol,
 * wraps in handle adapter, and returns fd number to calling process.
 *
 * ALGORITHM:
 * 1. Call hal.channel.open(proto, url, opts) to create channel (ASYNC)
 * 2. Create ChannelHandleAdapter wrapping channel
 * 3. Allocate fd and register handle in kernel table
 * 4. Log success for debugging
 * 5. Return fd number
 *
 * WHY ASYNC: HAL channel operations are async (connection establishment,
 * authentication, DNS lookup, etc.).
 *
 * DESIGN CHOICE: Why allocate fd after channel opens?
 * - Channel opening might fail (invalid URL, connection refused, etc.)
 * - Don't want fd allocated if channel creation fails
 * - Easier cleanup: no fd to unmap on error
 * - Channel is already created, just need to wrap it
 *
 * DESIGN CHOICE: Why log after allocation?
 * - Debugging aid: see which channels are opened
 * - Includes both protocol and fd number for correlation
 * - Proto comes from channel (not input) for accuracy
 *
 * DESIGN CHOICE: Why separate Channel and ChannelHandleAdapter?
 * - Channel implements protocol-specific logic (send, recv, close)
 * - ChannelHandleAdapter provides unified Handle interface
 * - Allows testing Channel in isolation
 * - Enables future protocol plugins
 *
 * ERROR HANDLING: Channel cleanup on allocation failure
 * - If allocHandle fails (EMFILE, process dead, etc.)
 * - Must close channel to release connection
 * - Otherwise connection leaks until kernel restart
 * - Remote peer may hold resources waiting for close
 *
 * @param self - Kernel instance
 * @param proc - Calling process
 * @param proto - Protocol (http, https, ws, wss, postgres, sqlite, sse)
 * @param url - Connection URL (protocol-specific format)
 * @param opts - Protocol-specific options (headers, auth, etc.)
 * @returns File descriptor number
 * @throws EINVAL - Invalid protocol or URL
 * @throws ECONNREFUSED - Connection refused by remote
 * @throws EMFILE - Too many open handles
 */
export async function openChannel(
    self: Kernel,
    proc: Process,
    proto: string,
    url: string,
    opts?: ChannelOpts,
): Promise<number> {
    // Open channel connection (ASYNC - process could die here)
    const channel = await self.hal.channel.open(proto, url, opts);

    // RACE FIX: Check process still running after await (TODO)
    // If process died while opening, close channel and bail
    // (Currently not implemented - channel leaks if process killed)

    // Wrap channel in adapter for Handle interface
    const adapter = new ChannelHandleAdapter(
        channel.id,
        channel,
        `${channel.proto}:${channel.description}`,
    );

    // Allocate fd and register in kernel table
    // If this fails, channel stays open - BUG
    // TODO: Wrap in try/catch, close channel on error
    const h = allocHandle(self, proc, adapter);

    // Log successful channel open for debugging
    // WHY LOG: Helps trace protocol usage and connection lifecycle
    printk(
        self,
        'channel',
        `opened ${channel.proto}:${channel.description} as fd ${h}`,
    );

    return h;
}
