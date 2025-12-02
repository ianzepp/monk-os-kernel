/**
 * Storage Engine
 *
 * Structured key-value storage with transactions and subscriptions.
 * Primary data store for VFS and application data.
 *
 * Bun touchpoints:
 * - bun:sqlite for embedded SQLite
 * - Database class from bun:sqlite
 *
 * Caveats:
 * - SQLite WAL mode recommended for concurrent reads
 * - watch() uses polling in SQLite (no native change notifications)
 * - PostgreSQL implementation would use LISTEN/NOTIFY for real subscriptions
 */

// Re-export types
export type { StorageStat, WatchEvent, Transaction, StorageEngine } from './storage/types.js';

// Re-export implementations
export { BunStorageEngine } from './storage/sqlite.js';
export { MemoryStorageEngine } from './storage/memory.js';
