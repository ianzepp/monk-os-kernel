/**
 * Memory Storage Engine
 *
 * In-memory storage engine for testing and ephemeral storage.
 *
 * Useful for:
 * - Testing (fast, isolated)
 * - Standalone mode with ephemeral storage
 *
 * Caveats:
 * - All data lost on process exit
 * - No persistence
 * - Transactions are fake (no real isolation)
 */

import type { StorageEngine, StorageStat, Transaction, WatchEvent } from './types.js';

/**
 * In-memory storage engine
 */
export class MemoryStorageEngine implements StorageEngine {
    private data: Map<string, { value: Uint8Array; mtime: number }> = new Map();
    private watchers: Map<string, Set<(event: WatchEvent) => void>> = new Map();

    async get(key: string): Promise<Uint8Array | null> {
        const entry = this.data.get(key);

        return entry?.value ?? null;
    }

    async put(key: string, value: Uint8Array): Promise<void> {
        const timestamp = Date.now();

        this.data.set(key, { value, mtime: timestamp });
        this.emit({ key, op: 'put', value, timestamp });
    }

    async delete(key: string): Promise<void> {
        const timestamp = Date.now();

        this.data.delete(key);
        this.emit({ key, op: 'delete', timestamp });
    }

    async *list(prefix: string): AsyncIterable<string> {
        const keys = Array.from(this.data.keys())
            .filter(k => k.startsWith(prefix))
            .sort();

        for (const key of keys) {
            yield key;
        }
    }

    async exists(key: string): Promise<boolean> {
        return this.data.has(key);
    }

    async stat(key: string): Promise<StorageStat | null> {
        const entry = this.data.get(key);

        if (!entry) {
            return null;
        }

        return { size: entry.value.length, mtime: entry.mtime };
    }

    async begin(): Promise<Transaction> {
        // Memory transactions don't provide real isolation
        // This is a simplified implementation for testing
        return new MemoryTransaction(this);
    }

    async *watch(pattern: string): AsyncIterable<WatchEvent> {
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

        if (!this.watchers.has(pattern)) {
            this.watchers.set(pattern, new Set());
        }

        this.watchers.get(pattern)!.add(callback);

        try {
            while (true) {
                if (queue.length > 0) {
                    yield queue.shift()!;
                }
                else {
                    await new Promise<void>(r => {
                        resolve = r;
                    });
                }
            }
        }
        finally {
            this.watchers.get(pattern)?.delete(callback);
            if (this.watchers.get(pattern)?.size === 0) {
                this.watchers.delete(pattern);
            }
        }
    }

    private emit(event: WatchEvent): void {
        for (const [pattern, callbacks] of this.watchers) {
            if (this.matchPattern(pattern, event.key)) {
                for (const callback of callbacks) {
                    callback(event);
                }
            }
        }
    }

    private matchPattern(pattern: string, key: string): boolean {
        const regex = pattern
            .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<<DOUBLESTAR>>>/g, '.*');

        return new RegExp(`^${regex}$`).test(key);
    }

    async close(): Promise<void> {
        this.data.clear();
        this.watchers.clear();
    }

    /**
     * Reset storage to empty state.
     * Testing convenience method.
     */
    reset(): void {
        this.data.clear();
    }

    /**
     * Internal: emit event (for transaction use)
     */
    _emit(event: WatchEvent): void {
        this.emit(event);
    }
}

/**
 * Memory transaction implementation
 */
class MemoryTransaction implements Transaction {
    private committed = false;
    private rolledBack = false;
    private operations: Array<{ type: 'put' | 'delete'; key: string; value?: Uint8Array }> = [];

    constructor(private engine: MemoryStorageEngine) {}

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.committed && !this.rolledBack) {
            await this.rollback();
        }
    }

    async get(key: string): Promise<Uint8Array | null> {
        // Check pending operations first
        for (let i = this.operations.length - 1; i >= 0; i--) {
            const op = this.operations[i]!;

            if (op.key === key) {
                return op.type === 'put' ? op.value! : null;
            }
        }

        return this.engine.get(key);
    }

    async put(key: string, value: Uint8Array): Promise<void> {
        this.operations.push({ type: 'put', key, value });
    }

    async delete(key: string): Promise<void> {
        this.operations.push({ type: 'delete', key });
    }

    async commit(): Promise<void> {
        if (this.committed) {
            return;
        }

        this.committed = true;

        for (const op of this.operations) {
            if (op.type === 'put') {
                await this.engine.put(op.key, op.value!);
            }
            else {
                await this.engine.delete(op.key);
            }
        }
    }

    async rollback(): Promise<void> {
        if (this.committed || this.rolledBack) {
            return;
        }

        this.rolledBack = true;
        this.operations = [];
    }
}
