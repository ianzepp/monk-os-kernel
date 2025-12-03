/**
 * Channel Device - Protocol-aware bidirectional message exchange
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Channels are the third I/O primitive in Monk OS, alongside file descriptors
 * (Resources) and Ports. While files provide byte-oriented I/O and ports provide
 * unidirectional message delivery, channels provide protocol-aware bidirectional
 * message exchange over persistent connections.
 *
 * Key characteristics:
 * - Protocol-aware: Understands HTTP, WebSocket, PostgreSQL, SQLite wire protocols
 * - Bidirectional: Both sides can send and receive (unlike ports)
 * - Persistent: Connection remains open for multiple messages
 * - Message-based: Sends/receives structured messages, not raw bytes
 *
 * Supported protocols:
 * - http/https: HTTP client using fetch() - request/response pattern
 * - websocket: WebSocket bidirectional streaming - full-duplex messaging
 * - sse: Server-Sent Events - server-to-client push
 * - postgres: PostgreSQL wire protocol via Bun.sql() - query/result pattern
 * - sqlite: SQLite via bun:sqlite - query/result pattern
 *
 * WHY: Channels abstract protocol details from userland. Process code can
 * interact with HTTP, WebSocket, PostgreSQL, etc. using uniform Channel interface
 * without understanding wire protocols, framing, multiplexing, etc.
 *
 * DESIGN RATIONALE:
 * Files (byte streams) are too low-level for request/response protocols - userland
 * would need to implement HTTP parsing, WebSocket framing, SQL protocol, etc.
 *
 * Channels are too high-level for raw networking - they impose protocol semantics
 * (request/response, framing, message boundaries).
 *
 * Channels sit between files and ports: higher-level than files (protocol-aware),
 * more persistent than ports (long-lived connections).
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Channel implementations exist in ./channel/ subdirectory
 * INV-2: All channel types export Channel interface and device-specific types
 * INV-3: BunChannelDevice aggregates all channel implementations
 * INV-4: Channel interface provides exec(msg) → AsyncIterable<Response> pattern
 * INV-5: Channels must be closed via close() to release connection resources
 *
 * CONCURRENCY MODEL
 * =================
 * Each channel type handles concurrency differently based on protocol:
 * - HTTP: Stateless request/response, concurrent requests allowed
 * - WebSocket: Stateful bidirectional, messages may interleave
 * - PostgreSQL: Pipelined queries, responses ordered but may interleave
 * - SQLite: Single-writer (transactions serialize writes)
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Each channel implementation handles connection lifecycle races
 * RC-2: Channel operations check closed state before sending
 * RC-3: Close operations are idempotent across all channel types
 *
 * MEMORY MANAGEMENT
 * =================
 * - Channels own connection resources (sockets, database handles)
 * - close() must release all resources
 * - Kernel closes all channels when process exits
 * - Long-lived channels (WebSocket, database) should implement keepalive
 *
 * TESTABILITY
 * ===========
 * This barrel file simplifies testing:
 * - Import all channel types from single module
 * - Mock channel implementations can be swapped
 * - Test channel behavior without real network/database connections
 *
 * @module hal/channel
 */

// =============================================================================
// RE-EXPORTS
// =============================================================================
// WHY: Barrel file pattern consolidates imports. Consumers import from
// hal/channel instead of hal/channel/types, hal/channel/device, etc.

// Re-export types
// WHY: Core channel interface and options used across all implementations
export type { Channel, ChannelDevice, ChannelOpts, HttpRequest, QueryData } from './channel/types.js';

// Re-export implementations
// WHY: Each protocol has dedicated implementation in ./channel/ subdirectory
export { BunChannelDevice } from './channel/device.js';
export { BunHttpChannel } from './channel/http.js';
export { BunWebSocketClientChannel } from './channel/websocket.js';
export { BunSSEServerChannel } from './channel/sse.js';
export { BunPostgresChannel } from './channel/postgres.js';
export { BunSqliteChannel } from './channel/sqlite.js';
