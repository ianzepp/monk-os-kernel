/**
 * Resource Module - Port and Message Pipe Implementations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module serves as the central export point for kernel resource
 * abstractions - specifically Ports and MessagePipes. These are the building
 * blocks of event-driven I/O and inter-process communication in Monk OS.
 *
 * The resource layer sits between the kernel and HAL layers:
 * - HAL provides low-level primitives (sockets, timers, storage, watchers)
 * - Resource layer wraps HAL primitives with Port/Pipe abstractions
 * - Kernel exposes these to userspace via syscalls (listen, watch, pipe, etc.)
 *
 * WHY separate resource layer from HAL:
 * HAL focuses on hardware abstraction - mimicking OS device drivers. Resource
 * layer focuses on kernel-level messaging patterns. For example, HAL provides
 * raw NetworkDevice.listen() that returns a Socket, but ListenerPort wraps
 * this to yield PortMessages with consistent structure across all port types.
 *
 * WHY separate from kernel:
 * Kernel handles process lifecycle, syscall dispatch, handle management. These
 * concerns are orthogonal to the specific implementation of how TCP listeners
 * or file watchers queue messages. Separation allows testing resource
 * implementations in isolation.
 *
 * MODULE STRUCTURE
 * ================
 * This is a barrel export module that re-exports:
 * 1. Types (Port, PortMessage, PortType, UdpSocketOpts)
 * 2. Port implementations (ListenerPort, WatchPort, UdpPort, PubsubPort)
 * 3. Message pipe implementation (MessagePipe, createMessagePipe, PipeEnd)
 *
 * Port Implementations:
 * - ListenerPort: TCP server sockets (yields Socket handles on accept)
 * - WatchPort: VFS file system watcher (yields file change events)
 * - UdpPort: UDP datagram socket (send/recv datagrams)
 * - PubsubPort: Topic-based pub/sub (subscribe/publish messages)
 *
 * MessagePipe:
 * - Bidirectional message channel between processes
 * - Created by pipe() syscall, returns two ends (recv-only and send-only)
 * - Used for parent/child process communication
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All exported Ports implement the Port interface from types.ts
 * INV-2: All exported types match their corresponding implementation modules
 * INV-3: Module exports are read-only (no mutable state at module level)
 * INV-4: Re-exports maintain original type signatures (no wrapping/transformation)
 *
 * CONCURRENCY MODEL
 * =================
 * This module itself has no concurrency concerns - it's a pure barrel export.
 * Individual port implementations have their own concurrency models documented
 * in their respective files.
 *
 * MEMORY MANAGEMENT
 * =================
 * No memory management at this layer - simply re-exporting other modules.
 * Actual resource lifecycle is managed by individual port implementations.
 *
 * @module kernel/resource
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Core port types and interfaces.
 *
 * WHY exported first:
 * TypeScript best practice - export types before implementations for better
 * IDE autocomplete and documentation ordering.
 */
export type { Port, PortMessage, PortType, UdpSocketOpts } from './types.js';

// =============================================================================
// PORT IMPLEMENTATIONS
// =============================================================================

/**
 * TCP listener port.
 *
 * WHY:
 * Wraps HAL NetworkDevice.listen() to provide Port interface. Yields
 * PortMessages containing accepted Socket handles.
 *
 * Usage:
 *   const port = new ListenerPort(hal, { port: 8080 });
 *   const msg = await port.recv();  // msg.socket is accepted connection
 */
export { ListenerPort } from './listener-port.js';

/**
 * File system watcher port.
 *
 * WHY:
 * Wraps VFS watch() to provide Port interface. Yields PortMessages
 * containing file change events.
 *
 * Usage:
 *   const port = new WatchPort(vfs, '/var/log/*.log');
 *   const msg = await port.recv();  // msg: { from: path, meta: { op, timestamp } }
 *
 * TESTABILITY:
 * VfsWatchEvent type exported separately for test assertions.
 */
export { WatchPort, type VfsWatchEvent } from './watch-port.js';

/**
 * UDP datagram port.
 *
 * WHY:
 * Wraps HAL NetworkDevice UDP socket to provide Port interface. Supports
 * both recv() for incoming datagrams and send() for outgoing.
 *
 * Usage:
 *   const port = new UdpPort(hal, { bind: 9000 });
 *   const msg = await port.recv();  // msg: { from: "ip:port", data: Uint8Array }
 *   await port.send("192.168.1.100:9000", data);
 */
export { UdpPort } from './udp-port.js';

/**
 * Topic-based pub/sub port.
 *
 * WHY:
 * Provides internal kernel message bus for event distribution. Processes can
 * subscribe to topic patterns (e.g., "log.*") and receive matching messages.
 *
 * Usage:
 *   const port = new PubsubPort(pubsubHub, ["log.error", "log.warn"]);
 *   const msg = await port.recv();  // msg: { from: "log.error", meta: { ... } }
 *
 * TESTABILITY:
 * matchTopic() utility exported for testing topic pattern matching logic.
 */
export { PubsubPort, matchTopic } from './pubsub-port.js';

// =============================================================================
// MESSAGE PIPE
// =============================================================================

/**
 * Message pipe for inter-process communication.
 *
 * WHY MessagePipe vs Port:
 * - MessagePipe is bidirectional (both ends can send/recv)
 * - Ports are unidirectional or specialized (UDP is exception)
 * - MessagePipe connects exactly two endpoints (like UNIX pipe)
 * - Ports can have multiple receivers (pub/sub) or senders (UDP multicast)
 *
 * WHY message-based instead of byte-based:
 * Traditional UNIX pipes are byte streams. Monk OS uses structured messages
 * internally - byte serialization only at true I/O boundaries (disk, network).
 * MessagePipe preserves message boundaries and structured data.
 *
 * Usage:
 *   const [pipeA, pipeB] = createMessagePipe(hal);
 *   // Process A:
 *   await pipeA.send({ op: 'ping' });
 *   const response = await pipeA.recv();
 *   // Process B:
 *   const request = await pipeB.recv();
 *   await pipeB.send({ op: 'pong' });
 *
 * TESTABILITY:
 * PipeEnd type exported to verify which end of pipe is being used (recv vs send).
 */
export { MessagePipe, createMessagePipe, type PipeEnd } from './message-pipe.js';
