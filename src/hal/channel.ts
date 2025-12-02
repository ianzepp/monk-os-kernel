/**
 * Channel Device
 *
 * Protocol-aware bidirectional message exchange over persistent connections.
 * Channels are the third I/O primitive in Monk OS, alongside file descriptors
 * (Resources) and Ports.
 *
 * Supported protocols:
 * - http/https: HTTP client using fetch()
 * - sse: Server-Sent Events (server push)
 * - websocket: WebSocket bidirectional
 * - postgres: PostgreSQL via Bun.sql
 * - sqlite: SQLite via bun:sqlite
 *
 * Bun touchpoints:
 * - fetch() for HTTP/HTTPS
 * - Bun.serve() for SSE/WebSocket server-side
 * - Bun.sql() for PostgreSQL
 * - bun:sqlite for SQLite
 */

// Re-export types
export type { Channel, ChannelDevice, ChannelOpts, HttpRequest, QueryData } from './channel/types.js';

// Re-export implementations
export { BunChannelDevice } from './channel/device.js';
export { BunHttpChannel } from './channel/http.js';
export { BunWebSocketClientChannel } from './channel/websocket.js';
export { BunSSEServerChannel } from './channel/sse.js';
export { BunPostgresChannel } from './channel/postgres.js';
export { BunSqliteChannel } from './channel/sqlite.js';
