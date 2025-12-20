/**
 * Memory Redis - In-process cache + pub/sub implementation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * In-memory implementation of RedisDevice for development, testing, and
 * single-node deployments. Provides identical semantics to a real Redis
 * server for the subset of operations in the RedisDevice interface.
 *
 * Two main subsystems:
 * 1. Cache: Map-based key-value store with TTL support
 * 2. Pub/Sub: Topic pattern matching with async message delivery
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Cache operations are synchronous internally (JS single-threaded)
 * INV-2: Expired keys are lazily deleted on access
 * INV-3: TTL timers are cleaned up on key deletion or shutdown
 * INV-4: Subscriptions receive messages in publish order
 * INV-5: Closed subscriptions stop receiving messages immediately
 * INV-6: shutdown() cleans up all timers and subscriptions
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded, so cache operations are inherently atomic.
 * Pub/sub uses async queues with waiters pattern for message delivery.
 *
 * The async interface (Promise returns) maintains API compatibility with
 * Redis backend while being synchronous internally.
 *
 * MEMORY MANAGEMENT
 * =================
 * - Cache entries stored in Map (garbage collected on delete)
 * - TTL timers stored in separate Map (cleared on delete/expire)
 * - Subscriptions maintain message queues (bounded by message rate)
 * - shutdown() clears all state to prevent leaks
 *
 * TESTABILITY
 * ===========
 * This implementation is designed to match Redis semantics exactly.
 * Tests using MemoryRedis should produce identical results to Redis backend.
 *
 * @module hal/redis/memory
 */

import type { RedisDevice, PubsubSubscription, PubsubMessage, RedisConfig } from './types.js';

// =============================================================================
// MEMORY REDIS IMPLEMENTATION
// =============================================================================

/**
 * In-memory Redis device implementation.
 *
 * Suitable for:
 * - Development (no Redis server needed)
 * - Testing (deterministic, fast)
 * - Single-node deployments (no distributed state needed)
 *
 * Not suitable for:
 * - Multi-node deployments (no shared state)
 * - Persistence across restarts (state is ephemeral)
 */
export class MemoryRedis implements RedisDevice {
    // =========================================================================
    // CACHE STATE
    // =========================================================================

    /** Key-value store */
    private cache = new Map<string, string>();

    /** TTL timers by key */
    private timers = new Map<string, ReturnType<typeof setTimeout>>();

    /** Expiration timestamps (ms since epoch) by key */
    private expires = new Map<string, number>();

    // =========================================================================
    // PUBSUB STATE
    // =========================================================================

    /** Map of pattern -> Set of subscription IDs */
    private subscriptions = new Map<string, Set<string>>();

    /** Map of subscription ID -> subscription state */
    private subState = new Map<string, {
        patterns: string[];
        queue: PubsubMessage[];
        waiters: Array<(msg: PubsubMessage | null) => void>;
        closed: boolean;
    }>();

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    private readonly prefix: string;
    private readonly defaultTTL: number;

    constructor(config?: Partial<RedisConfig>) {
        this.prefix = config?.prefix ?? '';
        this.defaultTTL = config?.defaultTTL ?? 0;
    }

    // =========================================================================
    // INTERNAL HELPERS
    // =========================================================================

    /**
     * Apply key prefix.
     */
    private key(k: string): string {
        return this.prefix ? `${this.prefix}${k}` : k;
    }

    /**
     * Check if key is expired and delete if so.
     * Returns true if key exists and is not expired.
     */
    private checkExpiry(key: string): boolean {
        const expireTime = this.expires.get(key);

        if (expireTime && Date.now() > expireTime) {
            this.deleteKey(key);

            return false;
        }

        return this.cache.has(key);
    }

    /**
     * Delete a key and clean up associated timer.
     */
    private deleteKey(key: string): boolean {
        const existed = this.cache.has(key);

        this.cache.delete(key);
        this.expires.delete(key);
        const timer = this.timers.get(key);

        if (timer) {
            clearTimeout(timer);
            this.timers.delete(key);
        }

        return existed;
    }

    /**
     * Set TTL on a key.
     */
    private setTTL(key: string, ttlMs: number): void {
        // Clear existing timer
        const existingTimer = this.timers.get(key);

        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        if (ttlMs > 0) {
            this.expires.set(key, Date.now() + ttlMs);
            this.timers.set(key, setTimeout(() => this.deleteKey(key), ttlMs));
        }
        else {
            this.expires.delete(key);
            this.timers.delete(key);
        }
    }

    // =========================================================================
    // CACHE METHODS
    // =========================================================================

    async get(key: string): Promise<string | null> {
        const k = this.key(key);

        if (!this.checkExpiry(k)) {
            return null;
        }

        return this.cache.get(k) ?? null;
    }

    async set(key: string, value: string, opts?: { ex?: number; px?: number }): Promise<void> {
        const k = this.key(key);

        this.cache.set(k, value);

        // Calculate TTL in milliseconds
        const ttlMs = opts?.px ?? (opts?.ex ? opts.ex * 1000 : this.defaultTTL * 1000);

        this.setTTL(k, ttlMs);
    }

    async del(...keys: string[]): Promise<number> {
        let count = 0;

        for (const key of keys) {
            if (this.deleteKey(this.key(key))) {
                count++;
            }
        }

        return count;
    }

    async exists(key: string): Promise<boolean> {
        return this.checkExpiry(this.key(key));
    }

    async expire(key: string, seconds: number): Promise<boolean> {
        const k = this.key(key);

        if (!this.checkExpiry(k)) {
            return false;
        }

        this.setTTL(k, seconds * 1000);

        return true;
    }

    async ttl(key: string): Promise<number> {
        const k = this.key(key);

        if (!this.cache.has(k)) {
            return -2;
        }

        // Check expiration
        const expireTime = this.expires.get(k);

        if (expireTime && Date.now() > expireTime) {
            this.deleteKey(k);

            return -2;
        }

        if (!expireTime) {
            return -1;
        }

        return Math.max(0, Math.ceil((expireTime - Date.now()) / 1000));
    }

    async incr(key: string): Promise<number> {
        return this.incrby(key, 1);
    }

    async incrby(key: string, increment: number): Promise<number> {
        const k = this.key(key);
        const current = this.checkExpiry(k) ? this.cache.get(k) ?? null : null;

        if (current !== null && isNaN(parseInt(current, 10))) {
            throw new Error('ERR value is not an integer or out of range');
        }

        const value = (current ? parseInt(current, 10) : 0) + increment;

        this.cache.set(k, value.toString());

        return value;
    }

    async decr(key: string): Promise<number> {
        return this.incrby(key, -1);
    }

    async mget(...keys: string[]): Promise<(string | null)[]> {
        return Promise.all(keys.map(k => this.get(k)));
    }

    async mset(entries: Record<string, string>): Promise<void> {
        for (const [key, value] of Object.entries(entries)) {
            await this.set(key, value);
        }
    }

    async setnx(key: string, value: string): Promise<boolean> {
        const k = this.key(key);

        // Atomic check-and-set (matches Redis SETNX semantics)
        // Synchronous check ensures atomicity in single-threaded JS
        if (this.checkExpiry(k)) {
            return false;
        }

        this.cache.set(k, value);

        return true;
    }

    // =========================================================================
    // PUBSUB METHODS
    // =========================================================================

    async subscribe(patterns: string[]): Promise<PubsubSubscription> {
        const id = crypto.randomUUID();
        const state = {
            patterns,
            queue: [] as PubsubMessage[],
            waiters: [] as Array<(msg: PubsubMessage | null) => void>,
            closed: false,
        };

        this.subState.set(id, state);

        // Register subscription for each pattern
        for (const pattern of patterns) {
            const prefixedPattern = this.prefix ? `${this.prefix}${pattern}` : pattern;

            if (!this.subscriptions.has(prefixedPattern)) {
                this.subscriptions.set(prefixedPattern, new Set());
            }

            this.subscriptions.get(prefixedPattern)!.add(id);
        }

        const self = this;

        return {
            id,
            patterns,
            messages: () => self.iterate(id),
            close: () => self.unsubscribe(id),
        };
    }

    async publish(topic: string, payload: unknown): Promise<number> {
        const prefixedTopic = this.prefix ? `${this.prefix}${topic}` : topic;
        let count = 0;

        for (const [pattern, subIds] of this.subscriptions) {
            if (this.matches(pattern, prefixedTopic)) {
                for (const subId of subIds) {
                    const state = this.subState.get(subId);

                    if (state && !state.closed) {
                        // Strip prefix from pattern for message
                        const userPattern = this.prefix && pattern.startsWith(this.prefix)
                            ? pattern.slice(this.prefix.length)
                            : pattern;

                        const msg: PubsubMessage = { topic, payload, pattern: userPattern };

                        // If someone is waiting, deliver directly
                        const waiter = state.waiters.shift();

                        if (waiter) {
                            waiter(msg);
                        }
                        else {
                            state.queue.push(msg);
                        }

                        count++;
                    }
                }
            }
        }

        return count;
    }

    async subscriberCount(pattern: string): Promise<number> {
        // Returns count of subscriptions to this exact pattern.
        // Matches Redis PUBSUB NUMSUB semantics: does not count pattern subscribers
        // that would match a topic, only exact pattern matches.
        const prefixedPattern = this.prefix ? `${this.prefix}${pattern}` : pattern;

        return this.subscriptions.get(prefixedPattern)?.size ?? 0;
    }

    /**
     * Async iterator for subscription messages.
     */
    private async *iterate(id: string): AsyncIterable<PubsubMessage> {
        const state = this.subState.get(id);

        if (!state) {
            return;
        }

        while (!state.closed) {
            // Drain queue first
            if (state.queue.length > 0) {
                yield state.queue.shift()!;
                continue;
            }

            // Wait for next message
            const msg = await new Promise<PubsubMessage | null>(resolve => {
                if (state.closed) {
                    resolve(null);

                    return;
                }

                state.waiters.push(resolve);
            });

            if (msg === null) {
                break;
            }

            yield msg;
        }
    }

    /**
     * Unsubscribe and clean up subscription state.
     */
    private async unsubscribe(id: string): Promise<void> {
        const state = this.subState.get(id);

        if (!state) {
            return;
        }

        state.closed = true;

        // Wake up any waiters with null to signal close
        for (const waiter of state.waiters) {
            waiter(null);
        }

        // Remove from pattern maps
        for (const pattern of state.patterns) {
            const prefixedPattern = this.prefix ? `${this.prefix}${pattern}` : pattern;

            this.subscriptions.get(prefixedPattern)?.delete(id);
            // Clean up empty pattern sets
            if (this.subscriptions.get(prefixedPattern)?.size === 0) {
                this.subscriptions.delete(prefixedPattern);
            }
        }

        this.subState.delete(id);
    }

    /**
     * Check if pattern matches topic.
     *
     * Pattern syntax:
     * - `*` matches one level (e.g., `event.*` matches `event.chat`)
     * - `**` matches any levels (e.g., `event.**` matches `event.chat.room`)
     */
    private matches(pattern: string, topic: string): boolean {
        // Convert glob pattern to regex
        // event.* -> event\.[^.]+
        // event.** -> event\..*
        //
        // Use placeholder to avoid ** being partially consumed by * replacement.
        // Order matters: escape dots first, then replace ** (greedy), then * (single-level).
        const DOUBLE_STAR = '\x00DOUBLESTAR\x00';
        const regex = pattern
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, DOUBLE_STAR)
            .replace(/\*/g, '[^.]+')
            .replace(new RegExp(DOUBLE_STAR, 'g'), '.*');

        return new RegExp(`^${regex}$`).test(topic);
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    async shutdown(): Promise<void> {
        // Clean up subscriptions
        for (const id of this.subState.keys()) {
            await this.unsubscribe(id);
        }

        // Clean up TTL timers to prevent post-shutdown callbacks
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }

        this.timers.clear();
        this.cache.clear();
        this.expires.clear();
    }
}
