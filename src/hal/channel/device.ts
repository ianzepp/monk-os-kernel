/**
 * Channel Device - Protocol-aware connection factory
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The ChannelDevice is the HAL-level factory for creating protocol-aware
 * communication channels. Unlike raw sockets or file handles, channels
 * understand application protocols (HTTP, WebSocket, PostgreSQL, etc.) and
 * provide message-based interfaces that hide wire protocol details from userland.
 *
 * This design enables processes to communicate with external systems using
 * high-level operations (SQL queries, HTTP requests, WebSocket messages)
 * without implementing protocol parsers or dealing with byte streams.
 *
 * The device supports two creation modes:
 * 1. Client mode (open): Initiate connections to remote endpoints
 * 2. Server mode (accept): Wrap accepted sockets with protocol handlers
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All created channels must implement the Channel interface
 * INV-2: Unsupported protocols must throw errors immediately (fail-fast)
 * INV-3: Channel creation must not block indefinitely (protocol-specific timeouts)
 * INV-4: Each channel has a unique ID generated at construction time
 *
 * CONCURRENCY MODEL
 * =================
 * Channel creation is async but not inherently concurrent. Multiple processes
 * may call open() or accept() simultaneously, each receiving independent channel
 * instances. Channels do not share state with each other or the device.
 *
 * The device itself is stateless - it's a pure factory with no registry or
 * tracking of created channels. Channel lifecycle management is the caller's
 * responsibility (typically the kernel handle system).
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: No shared state between channels - each is isolated
 * RC-2: Channel implementations handle their own connection races
 * RC-3: Protocol-specific connection errors are propagated immediately
 *
 * MEMORY MANAGEMENT
 * =================
 * The device itself has no resources to manage. Created channels own their
 * connections and must be closed by callers. The device does not track or
 * auto-close channels - this is intentional to avoid hidden reference keeping.
 *
 * @module hal/channel/device
 */

import type { Socket } from '../network/types.js';
import type { Channel, ChannelDevice, ChannelOpts } from './types.js';
import { BunHttpChannel } from './http.js';
import { BunHttpServerChannel } from './http-server.js';
import { BunWebSocketClientChannel } from './websocket.js';
import { BunSSEServerChannel } from './sse.js';
import { BunPostgresChannel } from './postgres.js';
import { BunSqliteChannel } from './sqlite.js';
import { debug } from '../../debug.js';

const log = debug('hal:channel');

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * Bun channel device implementation.
 *
 * WHY: Centralized protocol dispatch simplifies kernel syscall implementation.
 * The kernel can delegate all protocol-specific logic to this device.
 *
 * TESTABILITY: Protocol strings enable easy mocking - tests can intercept
 * specific protocols without stubbing all network layers.
 */
export class BunChannelDevice implements ChannelDevice {
    // =========================================================================
    // CLIENT CONNECTIONS
    // =========================================================================

    /**
     * Open a channel as client.
     *
     * WHY: Client mode initiates connections to remote endpoints. Each protocol
     * has different connection semantics (TCP handshake, HTTP request, SQL login)
     * but all present a unified Channel interface.
     *
     * ALGORITHM:
     * 1. Match protocol string to implementation class
     * 2. Instantiate channel (connection happens in constructor or lazily)
     * 3. Return channel - caller owns lifecycle
     *
     * SUPPORTED PROTOCOLS:
     * - http/https: HTTP client via fetch()
     * - websocket/ws/wss: WebSocket client
     * - postgres/postgresql: PostgreSQL via Bun.SQL
     * - sqlite: SQLite via bun:sqlite (file path in url)
     *
     * @param proto - Protocol type (case-sensitive)
     * @param url - Connection URL or path
     * @param opts - Protocol-specific options
     * @returns Channel instance (caller must close)
     * @throws Error if protocol is unsupported
     */
    async open(proto: string, url: string, opts?: ChannelOpts): Promise<Channel> {
        log('open proto=%s url=%s', proto, url);
        // WHY: Switch on protocol string enables easy extensibility - new protocols
        // just add cases. Could use a registry pattern but that adds complexity.
        switch (proto) {
            case 'http':
            case 'https':
                // WHY: fetch() is Bun's built-in HTTP client - connection pooling,
                // HTTP/2, etc. are handled automatically
                return new BunHttpChannel(url, opts);

            case 'websocket':
            case 'ws':
            case 'wss':
                // WHY: WebSocket provides bidirectional messaging over HTTP upgrade.
                // Supporting both ws: and websocket: for API convenience.
                return new BunWebSocketClientChannel(url, opts);

            case 'postgres':
            case 'postgresql':
                // WHY: Bun.SQL provides async PostgreSQL with connection pooling.
                // Both protocol names supported for compatibility.
                return new BunPostgresChannel(url, opts);

            case 'sqlite':
                // WHY: bun:sqlite is synchronous file-based - no network overhead.
                // url is file path, not network address.
                return new BunSqliteChannel(url, opts);

            default:
                // WHY: Fail-fast on unknown protocols - don't return null or undefined.
                // Caller should handle errors explicitly.
                log('unsupported protocol: %s', proto);
                throw new Error(`Unsupported protocol: ${proto}`);
        }
    }

    // =========================================================================
    // SERVER CONNECTIONS
    // =========================================================================

    /**
     * Wrap an accepted socket as server-side channel.
     *
     * WHY: Server-side channels wrap already-accepted TCP sockets with protocol
     * handlers. This separation enables socket acceptance (TCP handshake) to
     * happen in the network layer while protocol handling happens here.
     *
     * ALGORITHM:
     * 1. Socket is already accepted (TCP established)
     * 2. Wrap with protocol-specific channel implementation
     * 3. Return channel - caller owns lifecycle
     *
     * SUPPORTED PROTOCOLS:
     * - sse: Server-Sent Events (one-way push from server to client)
     * - websocket: Would require HTTP upgrade first (error for now)
     *
     * RACE CONDITION:
     * The socket may already have buffered data or could receive data during
     * channel construction. Channel implementations must handle this by reading
     * any available data immediately or setting up read callbacks.
     *
     * @param socket - Already-accepted TCP socket
     * @param proto - Protocol to layer on socket
     * @param opts - Protocol-specific options
     * @returns Channel instance (caller must close)
     * @throws Error if protocol is unsupported or requires HTTP upgrade
     */
    async accept(socket: Socket, proto: string, opts?: ChannelOpts): Promise<Channel> {
        log('accept proto=%s', proto);
        switch (proto) {
            case 'http':
            case 'http-server':
                // WHY: HTTP server channel handles request parsing and response formatting.
                // Wraps raw socket with HTTP/1.1 protocol handling.
                return new BunHttpServerChannel(socket, opts);

            case 'sse':
                // WHY: SSE is HTTP-compatible and works on raw sockets. The channel
                // sends HTTP response headers then streams events in text/event-stream format.
                return new BunSSEServerChannel(socket, opts);

            case 'websocket':
                // WHY: WebSocket requires HTTP upgrade handshake which must happen
                // before this method is called. HTTP server handles upgrade, then
                // creates WebSocket directly (not via this method).
                log('websocket accept requires HTTP upgrade first');
                throw new Error('WebSocket server channels should be created via HTTP upgrade');

            default:
                log('unsupported server protocol: %s', proto);
                throw new Error(`Unsupported server protocol: ${proto}`);
        }
    }
}
