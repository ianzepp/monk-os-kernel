/**
 * SQLite Storage Engine
 *
 * SQLite-backed storage engine using bun:sqlite
 *
 * Bun touchpoints:
 * - new Database(path) - open database
 * - db.run() - execute statements
 * - db.query() - prepare and run queries
 * - db.transaction() - wrap in transaction
 *
 * Caveats:
 * - WAL mode enabled for better concurrency
 * - BLOB storage for values (efficient binary)
 * - mtime tracked via trigger on update
 * - watch() uses polling, not triggers (triggers can't push to JS)
 */

import { Database } from 'bun:sqlite';
import type { StorageEngine, StorageStat, Transaction, WatchEvent } from './types.js';

/**
 * SQLite-backed storage engine using bun:sqlite
 */
export class BunStorageEngine implements StorageEngine {
    private db: Database;
    private watchers: Map<string, Set<(event: WatchEvent) => void>> = new Map();
    private pollInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * @param path - SQLite database path, or ':memory:' for in-memory
     */
    constructor(path: string) {
        this.db = new Database(path);
        this.init();
    }

    private init(): void {
        // Enable WAL mode for better concurrency
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA synchronous = NORMAL');

        // Create storage table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS storage (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL,
                mtime INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
            )
        `);

        // Index for prefix queries
        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_storage_key ON storage(key)
        `);

        // Trigger to update mtime on update
        this.db.run(`
            CREATE TRIGGER IF NOT EXISTS update_mtime
            AFTER UPDATE ON storage
            BEGIN
                UPDATE storage SET mtime = strftime('%s', 'now') * 1000
                WHERE key = NEW.key;
            END
        `);
    }

    async get(key: string): Promise<Uint8Array | null> {
        const row = this.db.query('SELECT value FROM storage WHERE key = ?').get(key) as
            | { value: Uint8Array }
            | null;
        return row?.value ?? null;
    }

    async put(key: string, value: Uint8Array): Promise<void> {
        this.db.run('INSERT OR REPLACE INTO storage (key, value, mtime) VALUES (?, ?, ?)', [
            key,
            value,
            Date.now(),
        ]);
        this.emit({ key, op: 'put', value, timestamp: Date.now() });
    }

    async delete(key: string): Promise<void> {
        this.db.run('DELETE FROM storage WHERE key = ?', [key]);
        this.emit({ key, op: 'delete', timestamp: Date.now() });
    }

    async *list(prefix: string): AsyncIterable<string> {
        const pattern = prefix + '%';
        const rows = this.db.query('SELECT key FROM storage WHERE key LIKE ? ORDER BY key').all(pattern) as Array<{
            key: string;
        }>;
        for (const row of rows) {
            yield row.key;
        }
    }

    async exists(key: string): Promise<boolean> {
        const row = this.db.query('SELECT 1 FROM storage WHERE key = ?').get(key);
        return row !== null;
    }

    async stat(key: string): Promise<StorageStat | null> {
        const row = this.db.query('SELECT length(value) as size, mtime FROM storage WHERE key = ?').get(key) as
            | { size: number; mtime: number }
            | null;
        return row ? { size: row.size, mtime: row.mtime } : null;
    }

    async begin(): Promise<Transaction> {
        // Use IMMEDIATE to acquire write lock at start, avoiding deadlocks
        this.db.run('BEGIN IMMEDIATE');
        return new SQLiteTransaction(this.db, this);
    }

    async *watch(pattern: string): AsyncIterable<WatchEvent> {
        // Convert glob pattern to tracking key
        const key = pattern;

        // Create a queue for this watcher
        const queue: WatchEvent[] = [];
        let resolve: (() => void) | null = null;

        const callback = (event: WatchEvent) => {
            if (this.matchPattern(pattern, event.key)) {
                queue.push(event);
                if (resolve) {
                    resolve();
                    resolve = null;
                }
            }
        };

        // Register watcher
        if (!this.watchers.has(key)) {
            this.watchers.set(key, new Set());
        }
        this.watchers.get(key)!.add(callback);

        try {
            while (true) {
                if (queue.length > 0) {
                    yield queue.shift()!;
                } else {
                    // Wait for next event
                    await new Promise<void>((r) => {
                        resolve = r;
                    });
                }
            }
        } finally {
            // Cleanup on break/return
            this.watchers.get(key)?.delete(callback);
            if (this.watchers.get(key)?.size === 0) {
                this.watchers.delete(key);
            }
        }
    }

    /**
     * Emit event to matching watchers
     */
    private emit(event: WatchEvent): void {
        for (const [pattern, callbacks] of this.watchers) {
            if (this.matchPattern(pattern, event.key)) {
                for (const callback of callbacks) {
                    callback(event);
                }
            }
        }
    }

    /**
     * Match key against glob pattern
     * Supports * (single segment) and ** (multiple segments)
     */
    private matchPattern(pattern: string, key: string): boolean {
        // Simple implementation: convert to regex
        const regex = pattern
            .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<<DOUBLESTAR>>>/g, '.*');
        return new RegExp(`^${regex}$`).test(key);
    }

    async close(): Promise<void> {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.db.close();
    }

    /**
     * Internal: commit transaction and emit events
     */
    _commit(): void {
        this.db.run('COMMIT');
    }

    /**
     * Internal: rollback transaction
     */
    _rollback(): void {
        this.db.run('ROLLBACK');
    }

    /**
     * Internal: emit event (for transaction use)
     */
    _emit(event: WatchEvent): void {
        this.emit(event);
    }
}

/**
 * SQLite transaction implementation
 */
class SQLiteTransaction implements Transaction {
    private committed = false;
    private rolledBack = false;
    private events: WatchEvent[] = [];

    constructor(
        private db: Database,
        private engine: BunStorageEngine
    ) {}

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.committed && !this.rolledBack) {
            await this.rollback();
        }
    }

    async get(key: string): Promise<Uint8Array | null> {
        const row = this.db.query('SELECT value FROM storage WHERE key = ?').get(key) as
            | { value: Uint8Array }
            | null;
        return row?.value ?? null;
    }

    async put(key: string, value: Uint8Array): Promise<void> {
        this.db.run('INSERT OR REPLACE INTO storage (key, value, mtime) VALUES (?, ?, ?)', [
            key,
            value,
            Date.now(),
        ]);
        this.events.push({ key, op: 'put', value, timestamp: Date.now() });
    }

    async delete(key: string): Promise<void> {
        this.db.run('DELETE FROM storage WHERE key = ?', [key]);
        this.events.push({ key, op: 'delete', timestamp: Date.now() });
    }

    async commit(): Promise<void> {
        if (this.committed) return;
        this.committed = true;
        this.engine._commit();
        // Emit events after commit
        for (const event of this.events) {
            this.engine._emit(event);
        }
    }

    async rollback(): Promise<void> {
        if (this.committed || this.rolledBack) return;
        this.rolledBack = true;
        this.engine._rollback();
        this.events = [];
    }
}
