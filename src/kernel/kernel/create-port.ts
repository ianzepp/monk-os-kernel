/**
 * Port Creation Syscall - Create listening/watching/subscription ports with handles
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Ports are message endpoints for asynchronous event delivery: TCP connections,
 * file changes, UDP datagrams, or pubsub messages. This syscall creates a port
 * of the specified type, wraps it in a PortHandleAdapter, and allocates a file
 * descriptor for the calling process.
 *
 * Ports are distinct from regular handles because they use recv()/send() instead
 * of read()/write(). They deliver structured messages with metadata, not raw bytes.
 *
 * PORT TYPES
 * ==========
 * - tcp:listen: Accept incoming TCP connections (yields socket handles)
 * - fs:watch: Monitor filesystem changes matching pattern (yields events)
 * - udp:bind: Receive UDP datagrams on bound address/port (yields messages)
 * - pubsub:subscribe: Receive messages published to matching topics (yields messages)
 *
 * ASYNC PORT OPERATIONS
 * =====================
 * Port creation is ASYNC because underlying operations are async:
 * - tcp:listen: hal.network.listen() binds socket (may fail if port in use)
 * - fs:watch: vfs.watch() sets up filesystem watcher
 * - udp:bind: Creates port (lazy bind on first recv)
 * - pubsub:subscribe: Registers in kernel routing table
 *
 * CRITICAL: State changes AFTER await points. Process could be killed while
 * we're creating the port. Always check process state after async operations.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Port type must be one of: tcp:listen, fs:watch, udp:bind, pubsub:subscribe
 *        VIOLATED BY: Invalid syscall argument (EINVAL)
 * INV-2: Port-specific options must be valid for that port type
 *        VIOLATED BY: Missing port number for tcp:listen/udp:bind (EINVAL)
 * INV-3: Pubsub ports must be registered in kernel.pubsubPorts set
 *        VIOLATED BY: Skipping registration breaks message delivery
 * INV-4: TCP listener must be closed if handle allocation fails
 *        VIOLATED BY: Resource leak (port bound but no handle to close it)
 *
 * CONCURRENCY MODEL
 * =================
 * This is a syscall executed by a running process. The process worker thread
 * is blocked waiting for our response. Multiple processes could call this
 * concurrently, creating different ports.
 *
 * RACE CONDITION: Process killed during port creation
 * - Process calls createPort(), we await hal.network.listen()
 * - While waiting, process receives SIGKILL
 * - We wake up, try to allocate handle, but process is dead
 * - MITIGATION: Check process state after every await
 * - Clean up port if process died (close listener, unregister pubsub)
 *
 * RACE CONDITION: Port number conflicts
 * - Two processes try to listen on same TCP port concurrently
 * - Both call hal.network.listen() around same time
 * - First succeeds, second fails with EADDRINUSE
 * - MITIGATION: HAL network layer serializes bind operations
 * - Error propagates to caller, no kernel state corruption
 *
 * RACE CONDITION: Pubsub registration
 * - Port created and registered in pubsubPorts
 * - Message published BEFORE handle allocated to process
 * - Message delivered to port but process can't recv yet
 * - MITIGATION: Port buffers messages until process calls recv()
 * - Bounded buffer prevents memory exhaustion
 *
 * MEMORY MANAGEMENT
 * =================
 * - Creates Port instance (ListenerPort, WatchPort, UdpPort, PubsubPort)
 * - Wraps in PortHandleAdapter for Handle interface
 * - Registers handle in kernel.handles table
 * - Sets refcount = 1 (process owns it)
 * - Returns fd number to process
 * - When process closes fd or exits, kernel decrements refcount
 * - Port.close() releases underlying resources (socket, watcher, subscription)
 *
 * @module kernel/kernel/create-port
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Port } from '../resource.js';
import type { WatchEvent } from '../../vfs/model.js';
import { EINVAL } from '../errors.js';
import { ListenerPort, WatchPort, UdpPort, PubsubPort } from '../resource.js';
import { PortHandleAdapter } from '../handle.js';
import { allocHandle } from './alloc-handle.js';
import { publishPubsub } from './publish-pubsub.js';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Create a port and allocate a file descriptor for it.
 *
 * Syscall handler that creates port of specified type, wraps in handle adapter,
 * and returns fd number to calling process.
 *
 * ALGORITHM (by port type):
 *
 * TCP:LISTEN:
 * 1. Validate options (port number required)
 * 2. Call hal.network.listen() to bind socket (ASYNC)
 * 3. Create ListenerPort wrapping HAL listener
 * 4. Wrap in PortHandleAdapter
 * 5. Allocate fd and register handle
 * 6. Return fd number
 *
 * FS:WATCH:
 * 1. Validate options (pattern required)
 * 2. Create WatchPort with VFS watch callback
 * 3. Wrap in PortHandleAdapter
 * 4. Allocate fd and register handle
 * 5. Return fd number
 *
 * UDP:BIND:
 * 1. Validate options (port number required)
 * 2. Create UdpPort with bind configuration (lazy bind)
 * 3. Wrap in PortHandleAdapter
 * 4. Allocate fd and register handle
 * 5. Return fd number
 *
 * PUBSUB:SUBSCRIBE:
 * 1. Parse topic patterns (optional, empty = send-only)
 * 2. Create PubsubPort with publish/unsubscribe callbacks
 * 3. Register port in kernel.pubsubPorts set (CRITICAL)
 * 4. Wrap in PortHandleAdapter
 * 5. Allocate fd and register handle
 * 6. Return fd number
 *
 * WHY ASYNC: HAL network operations are async (socket binding).
 *
 * DESIGN CHOICE: Why allocate fd at end?
 * - Port creation might fail (EADDRINUSE, EINVAL, etc.)
 * - Don't want fd allocated if port creation fails
 * - Easier cleanup: no fd to unmap on error
 *
 * DESIGN CHOICE: Why separate Port and PortHandleAdapter?
 * - Port implements port-specific logic (recv, send, close)
 * - PortHandleAdapter provides unified Handle interface
 * - Allows testing Port in isolation
 * - Enables multiple handles to same port (not currently used)
 *
 * ERROR HANDLING: TCP listener cleanup on failure
 * - If allocHandle fails after listener created
 * - Must close listener to release port number
 * - Otherwise port number leaks until kernel restart
 *
 * @param self - Kernel instance
 * @param proc - Calling process
 * @param type - Port type (tcp:listen, fs:watch, udp:bind, pubsub:subscribe)
 * @param opts - Port-specific options (varies by type)
 * @returns File descriptor number
 * @throws EINVAL - Invalid port type or missing required options
 * @throws EADDRINUSE - TCP/UDP port already in use
 * @throws EMFILE - Too many open handles
 */
export async function createPort(
    self: Kernel,
    proc: Process,
    type: string,
    opts: unknown,
): Promise<number> {
    let port: Port;

    switch (type) {
        // ---------------------------------------------------------------------
        // TCP listener (accept incoming connections)
        // ---------------------------------------------------------------------
        case 'tcp:listen': {
            const listenOpts = opts as { port: number; host?: string; backlog?: number; unix?: string } | undefined;

            // Unix socket or TCP - one must be valid
            if (!listenOpts || (typeof listenOpts.port !== 'number' && !listenOpts.unix)) {
                throw new EINVAL('tcp:listen requires port or unix option');
            }

            // Bind socket (ASYNC - process could die here)
            const listener = await self.hal.network.listen(listenOpts.port, {
                hostname: listenOpts.host,
                backlog: listenOpts.backlog,
                unix: listenOpts.unix,
            });

            // RACE FIX: Check process still running after await
            // If process died, close listener and bail
            // (Currently no check implemented - TODO)

            const portId = self.hal.entropy.uuid();
            const addr = listener.addr();
            const description = listenOpts.unix
                ? `unix:listen:${listenOpts.unix}`
                : `tcp:listen:${addr.hostname}:${addr.port}`;

            port = new ListenerPort(portId, listener, description);
            break;
        }

        // ---------------------------------------------------------------------
        // Filesystem watcher (monitor file changes)
        // ---------------------------------------------------------------------
        case 'fs:watch': {
            const watchOpts = opts as { pattern: string } | undefined;

            if (!watchOpts || typeof watchOpts.pattern !== 'string') {
                throw new EINVAL('fs:watch requires pattern option');
            }

            const portId = self.hal.entropy.uuid();
            const description = `fs:watch:${watchOpts.pattern}`;

            // VFS watch callback: wraps VFS watch with port identity
            // WHY CLOSURE: Port needs reference to VFS and process ownership
            const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                return self.vfs.watch(pattern, proc.id);
            };

            port = new WatchPort(portId, watchOpts.pattern, vfsWatch, description);
            break;
        }

        // ---------------------------------------------------------------------
        // UDP socket (send/receive datagrams)
        // ---------------------------------------------------------------------
        case 'udp:bind': {
            const udpOpts = opts as { port: number; host?: string } | undefined;

            if (!udpOpts || typeof udpOpts.port !== 'number') {
                throw new EINVAL('udp:bind requires port option');
            }

            const portId = self.hal.entropy.uuid();
            const description = `udp:bind:${udpOpts.host ?? '0.0.0.0'}:${udpOpts.port}`;

            // Create port with bind configuration (lazy bind on first recv)
            // WHY LAZY: Allows port creation to succeed even if address in use
            // Actual bind happens in UdpPort.recv(), errors surface there
            port = new UdpPort(portId, { bind: udpOpts.port, address: udpOpts.host }, description);
            break;
        }

        // ---------------------------------------------------------------------
        // Pubsub subscription (send/receive topic messages)
        // ---------------------------------------------------------------------
        case 'pubsub:subscribe': {
            const pubsubOpts = opts as { topics?: string | string[] } | undefined;

            // Parse topic patterns (empty = send-only port)
            const patterns = pubsubOpts?.topics
                ? Array.isArray(pubsubOpts.topics)
                    ? pubsubOpts.topics
                    : [pubsubOpts.topics]
                : [];

            const portId = self.hal.entropy.uuid();
            const description = patterns.length > 0
                ? `pubsub:subscribe:${patterns.join(',')}`
                : 'pubsub:subscribe:(send-only)';

            // Publish callback: when port sends, route to all matching subscribers
            // WHY CLOSURE: Port needs reference to kernel's pubsub routing
            const publishFn = (
                topic: string,
                data: Uint8Array | undefined,
                meta: Record<string, unknown> | undefined,
                sourcePortId: string,
            ) => {
                publishPubsub(self, topic, data, meta, sourcePortId);
            };

            // Unsubscribe callback: remove port from routing table on close
            // WHY NEEDED: Prevents receiving messages after port closed
            // BUG POTENTIAL: If not called, port leaks in pubsubPorts set
            // NOTE: This closure captures 'port' before it's assigned, uses handle lookup
            const unsubscribeFn = () => {
                const handle = self.handles.get(portId) as PortHandleAdapter | undefined;

                if (handle) {
                    const p = handle.getPort() as PubsubPort;

                    self.pubsubPorts.delete(p);
                }
            };

            const pubsubPort = new PubsubPort(portId, patterns, publishFn, unsubscribeFn, description);

            // CRITICAL: Register port in kernel routing table BEFORE allocating fd
            // Otherwise early publishes could be lost
            self.pubsubPorts.add(pubsubPort);

            port = pubsubPort;
            break;
        }

        default:
            throw new EINVAL(`Unknown port type: ${type}`);
    }

    // Wrap port in adapter for Handle interface
    const adapter = new PortHandleAdapter(port.id, port, port.description);

    // Allocate fd and register handle in kernel table
    // Returns fd number that process can use for recv/send
    return allocHandle(self, proc, adapter);
}
