/**
 * I/O Source Handle Factory - Create read handles from service I/O configuration
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Service processes need flexible input sources: console input, file reads, pubsub
 * subscriptions, filesystem watches, or UDP datagrams. This factory creates Handle
 * instances for all these input types based on IOSource configuration.
 *
 * Each source type maps to a different underlying primitive:
 * - console → FileHandleAdapter wrapping VFS /dev/console
 * - file → FileHandleAdapter wrapping VFS file
 * - null → Inline Handle that immediately returns EOF
 * - pubsub:subscribe → PortHandleAdapter wrapping PubsubPort
 * - fs:watch → PortHandleAdapter wrapping WatchPort
 * - udp:bind → PortHandleAdapter wrapping UdpPort
 *
 * HANDLE ARCHITECTURE
 * ===================
 * All created handles implement the same Handle interface:
 * - exec(msg) → AsyncIterable<Response>
 * - close() → Promise<void>
 *
 * This allows ProcessIOHandle to treat all sources uniformly. The service code
 * doesn't know if it's reading from console, file, or network - just calls recv().
 *
 * PORT-BASED SOURCES (pubsub, watch, udp)
 * ========================================
 * These are "ports" - message endpoints that deliver structured events:
 * - PubsubPort: Receives messages published to matching topics
 * - WatchPort: Receives filesystem change events
 * - UdpPort: Receives UDP datagrams
 *
 * All ports are wrapped in PortHandleAdapter for Handle interface compatibility.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Source type must be one of: console, file, null, pubsub:subscribe, fs:watch, udp:bind
 *        VIOLATED BY: Invalid service configuration (validation failure)
 * INV-2: Pubsub ports must be initialized via init() after construction
 *        VIOLATED BY: Skipping init() breaks message delivery
 * INV-3: VFS paths (console, file) must be accessible by kernel user
 *        VIOLATED BY: Permission denied, file doesn't exist
 * INV-4: Handle IDs are globally unique UUIDs
 *        VIOLATED BY: UUID collision (extremely unlikely)
 *
 * CONCURRENCY MODEL
 * =================
 * This function is called during service spawn setup (async). Multiple services
 * could be spawning concurrently, each creating their own I/O handles.
 *
 * RACE CONDITION: Pubsub port registration
 * - port.init() must happen BEFORE any recv operations
 * - Otherwise early messages could be lost
 * - MITIGATION: Service doesn't start until this function completes
 *
 * RACE CONDITION: VFS operations (await self.vfs.open)
 * - File could be deleted between configuration and open
 * - MITIGATION: VFS open is atomic, will fail with ENOENT if missing
 * - Caller handles error (service spawn fails)
 *
 * MEMORY MANAGEMENT
 * =================
 * - Returns Handle instance (not registered in kernel table)
 * - Caller is responsible for registration and refcounting
 * - For ports, also creates Port instance held by Handle
 * - Port cleanup callbacks registered for pubsub (unsubscribe on close)
 * - FileHandleAdapter holds VFS handle (VFS manages cleanup)
 *
 * @module kernel/kernel/create-io-source-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { IOSource } from '../services.js';
import type { Handle } from '../handle.js';
import type { WatchEvent } from '../../vfs/model.js';
import { respond } from '../../message.js';
import { FileHandleAdapter, PortHandleAdapter } from '../handle.js';
import { PubsubPort, WatchPort, UdpPort } from '../resource.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Path to the console device in VFS.
 * WHY: DeviceModel exposes /dev/console for terminal I/O.
 */
const CONSOLE_PATH = '/dev/console';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Create a Handle for reading from the specified I/O source.
 *
 * Factory function that dispatches to appropriate Handle type based on
 * IOSource configuration. Returns Handle instance ready to use.
 *
 * ALGORITHM (by source type):
 *
 * CONSOLE:
 * 1. Open /dev/console with read flag
 * 2. Wrap VFS handle in FileHandleAdapter
 * 3. Return adapter
 *
 * FILE:
 * 1. Open configured file path with read flag
 * 2. Wrap VFS handle in FileHandleAdapter
 * 3. Return adapter
 *
 * NULL:
 * 1. Create inline Handle that yields done immediately
 * 2. Return handle (no underlying resource)
 *
 * PUBSUB:
 * 1. Parse topic patterns from config
 * 2. Create PubsubPort with HAL reference
 * 3. Initialize subscription via port.init()
 * 4. Wrap in PortHandleAdapter
 * 5. Return adapter
 *
 * FS:WATCH:
 * 1. Create WatchPort with VFS watch callback
 * 2. Wrap in PortHandleAdapter
 * 3. Return adapter
 *
 * UDP:BIND:
 * 1. Create UdpPort with bind address/port
 * 2. Wrap in PortHandleAdapter
 * 3. Return adapter
 *
 * WHY ASYNC: VFS open operations are async (filesystem I/O, permission checks).
 *
 * DESIGN CHOICE: Why not register handles in kernel table here?
 * - Separation of concerns: this creates, caller registers
 * - Caller knows the fd number and refcount semantics
 * - Allows testing without kernel table mutations
 *
 * EDGE CASE: Invalid source type
 * - TypeScript prevents this at compile time
 * - No runtime check needed (discriminated union)
 *
 * EDGE CASE: Pubsub cleanup
 * - Port.close() handles unsubscription from HAL redis
 * - No manual cleanup required
 * - Implemented via unsubscribeFn closure
 *
 * @param self - Kernel instance
 * @param source - I/O source configuration
 * @param proc - Process (for context, e.g., VFS watch ownership)
 * @returns Handle for reading from source
 */
export async function createIOSourceHandle(
    self: Kernel,
    source: IOSource,
    proc: Process,
): Promise<Handle> {
    switch (source.type) {
        // ---------------------------------------------------------------------
        // Console input (terminal stdin)
        // ---------------------------------------------------------------------
        case 'console': {
            // Open /dev/console through VFS (goes through DeviceModel → HAL console)
            const vfsHandle = await self.vfs.open(CONSOLE_PATH, { read: true }, 'kernel');

            return new FileHandleAdapter(vfsHandle.id, vfsHandle);
        }

        // ---------------------------------------------------------------------
        // File input (read from VFS file)
        // ---------------------------------------------------------------------
        case 'file': {
            // Open configured file path through VFS
            const vfsHandle = await self.vfs.open(source.path, { read: true }, 'kernel');

            return new FileHandleAdapter(vfsHandle.id, vfsHandle);
        }

        // ---------------------------------------------------------------------
        // Null input (immediate EOF, no data)
        // ---------------------------------------------------------------------
        case 'null': {
            // Inline Handle: exec() yields done, close() is no-op
            // WHY INLINE: No underlying resource, trivial implementation
            return {
                id: self.hal.entropy.uuid(),
                type: 'file' as const,                    // Pretend to be file for compatibility
                description: '/dev/null (input)',
                closed: false,
                async *exec() {
                    yield respond.done();
                }, // EOF immediately
                async close() {},                         // Nothing to clean up
            };
        }

        // ---------------------------------------------------------------------
        // Pubsub subscription (receive published messages)
        // ---------------------------------------------------------------------
        case 'pubsub:subscribe': {
            // Parse topic patterns (may be string or array)
            const patterns = Array.isArray(source.topics)
                ? source.topics
                : [source.topics];

            const portId = self.hal.entropy.uuid();
            const description = `pubsub:subscribe:${patterns.join(',')}`;

            // Create port with HAL reference for redis pub/sub
            const port = new PubsubPort(portId, self.hal, patterns, description);

            // Initialize subscription (ASYNC - creates HAL subscription)
            await port.init();

            // Wrap in adapter for Handle interface
            return new PortHandleAdapter(portId, port, description);
        }

        // ---------------------------------------------------------------------
        // Filesystem watch (receive file change events)
        // ---------------------------------------------------------------------
        case 'fs:watch': {
            const portId = self.hal.entropy.uuid();
            const description = `fs:watch:${source.pattern}`;

            // Watch callback: wraps VFS watch with port identity
            // WHY CLOSURE: Port needs reference to VFS and process ownership
            const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                return self.vfs.watch(pattern, proc.id);
            };

            // Create port (no registration needed, VFS manages watch lifecycle)
            const port = new WatchPort(portId, source.pattern, vfsWatch, description);

            // Wrap in adapter for Handle interface
            return new PortHandleAdapter(portId, port, description);
        }

        // ---------------------------------------------------------------------
        // UDP socket (receive datagrams)
        // ---------------------------------------------------------------------
        case 'udp:bind': {
            const portId = self.hal.entropy.uuid();
            const description = `udp:bind:${source.host ?? '0.0.0.0'}:${source.port}`;

            // Create port with bind configuration
            // WHY LAZY BIND: UdpPort binds socket on first recv(), not construction
            const port = new UdpPort(
                portId,
                { port: source.port, host: source.host },
                description,
            );

            // Wrap in adapter for Handle interface
            return new PortHandleAdapter(portId, port, description);
        }
    }
}
