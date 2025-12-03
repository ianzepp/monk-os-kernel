/**
 * Storage Engine - Structured key-value storage with transactions
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module provides the storage HAL (Hardware Abstraction Layer) for Monk OS.
 * It abstracts structured key-value storage with support for:
 *
 * - Key-value operations (get, put, delete)
 * - Prefix-based listing
 * - Atomic transactions
 * - Change subscriptions (watch)
 *
 * This is a barrel file that re-exports types and implementations from the
 * storage/ subdirectory. The actual implementation logic lives in:
 * - storage/types.ts - Interface definitions and types
 * - storage/sqlite.ts - SQLite-backed implementation (Bun)
 * - storage/memory.ts - In-memory implementation (testing)
 *
 * The storage engine is the primary data store for VFS metadata and application
 * data. It provides ACID properties via transactions and enables reactive patterns
 * via watch() subscriptions.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All exports are re-exports from storage/ subdirectory
 * INV-2: No implementation logic in this file
 * INV-3: Type exports must precede implementation exports for clarity
 *
 * BUN TOUCHPOINTS
 * ===============
 * - bun:sqlite - Embedded SQLite database
 * - Database class from bun:sqlite
 * - WAL mode for concurrent reads
 * - BLOB storage for efficient binary data
 *
 * CAVEATS
 * =======
 * - SQLite WAL mode recommended for concurrent reads, but only one writer at a time.
 * - watch() uses polling in SQLite (no native change notifications). For real-time
 *   subscriptions, PostgreSQL with LISTEN/NOTIFY would be preferred.
 * - Changes made outside the process are detected on next poll, not immediately.
 * - Transactions are serializable but may block on concurrent writers.
 *
 * @module hal/storage
 */

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type { StorageStat, WatchEvent, Transaction, StorageEngine } from './storage/types.js';

// =============================================================================
// IMPLEMENTATION EXPORTS
// =============================================================================

export { BunStorageEngine } from './storage/sqlite.js';
export { MemoryStorageEngine } from './storage/memory.js';
