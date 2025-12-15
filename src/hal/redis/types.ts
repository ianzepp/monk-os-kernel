/**
 * Redis Device - Cache + Pub/Sub interface types
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines the interface for Redis-like operations in Monk OS.
 * Two backends are supported:
 *
 * - Memory: In-process storage for dev/testing/single-node
 * - Redis: External Redis server for production/multi-node
 *
 * The interface combines two concerns:
 * 1. Cache: Key-value operations (get, set, del, expire, incr, etc.)
 * 2. Pub/Sub: Message passing with pattern matching
 *
 * Both backends implement the same interface, so switching from memory to
 * Redis requires only a config change.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Keys are strings, values are strings (JSON encode for objects)
 * INV-2: TTL is specified in seconds (ex) or milliseconds (px)
 * INV-3: Expired keys behave as if deleted (get returns null)
 * INV-4: Pattern matching uses glob syntax (* = one level, ** = any levels)
 * INV-5: Pub/sub messages are fire-and-forget (no persistence)
 * INV-6: Each subscription receives its own copy of messages
 *
 * SEMANTICS (matches Redis behavior)
 * ==================================
 * - get() on missing key returns null
 * - del() returns count of keys actually deleted
 * - ttl() returns -2 for missing key, -1 for no expiration
 * - incr() on missing key creates key with value 1
 * - setnx() is atomic (returns false if key exists)
 * - subscriberCount() counts exact pattern matches only (PUBSUB NUMSUB semantics)
 *
 * @module hal/redis/types
 */

// =============================================================================
// PUB/SUB TYPES
// =============================================================================

/**
 * Message received from a subscription.
 *
 * Contains the topic it was published to, the payload, and which pattern
 * matched to deliver this message.
 */
export interface PubsubMessage {
    /** The topic/channel the message was published to */
    topic: string;

    /** The message payload (already deserialized from JSON) */
    payload: unknown;

    /** Pattern that matched this topic (for wildcard subscriptions) */
    pattern: string;
}

/**
 * Subscription handle for managing a pub/sub subscription.
 *
 * Created by subscribe(), provides async iteration over messages and
 * cleanup via close().
 *
 * USAGE:
 *   const sub = await redis.subscribe(['event.*']);
 *   for await (const msg of sub.messages()) {
 *       console.log(msg.topic, msg.payload);
 *   }
 *   // Or close manually when done
 *   await sub.close();
 */
export interface PubsubSubscription {
    /** Unique subscription ID */
    readonly id: string;

    /** Patterns this subscription is listening to */
    readonly patterns: readonly string[];

    /**
     * Async iterator of incoming messages
     *
     * Yields messages as they arrive. Blocks until a message is available
     * or the subscription is closed.
     */
    messages(): AsyncIterable<PubsubMessage>;

    /**
     * Unsubscribe and clean up
     *
     * Stops receiving messages and releases resources. Any pending
     * messages() iteration will complete.
     */
    close(): Promise<void>;
}

// =============================================================================
// REDIS DEVICE INTERFACE
// =============================================================================

/**
 * HAL device for Redis-like operations.
 *
 * Provides cache (key-value) and pub/sub functionality.
 * Memory implementation for dev/single-node, Redis for production.
 *
 * PATTERN SYNTAX (pub/sub):
 * - `*` matches one level (e.g., `event.*` matches `event.chat` but not `event.chat.room`)
 * - `**` matches any levels (e.g., `event.**` matches `event.chat.room.123`)
 *
 * TESTABILITY:
 * MemoryRedis is the default implementation and works identically to a real Redis
 * server for the subset of operations exposed here. Tests can use MemoryRedis
 * with confidence that behavior matches production Redis.
 */
export interface RedisDevice {
    // =========================================================================
    // CACHE - Key/Value Operations
    // =========================================================================

    /**
     * Get a value by key.
     *
     * @param key - Key to retrieve
     * @returns Value or null if not found/expired
     */
    get(key: string): Promise<string | null>;

    /**
     * Set a value with optional TTL.
     *
     * @param key - Key to set
     * @param value - Value to store
     * @param opts - Options: ex (seconds TTL), px (milliseconds TTL)
     */
    set(key: string, value: string, opts?: { ex?: number; px?: number }): Promise<void>;

    /**
     * Delete one or more keys.
     *
     * @param keys - Keys to delete
     * @returns Number of keys that were actually deleted
     */
    del(...keys: string[]): Promise<number>;

    /**
     * Check if key exists.
     *
     * @param key - Key to check
     * @returns true if key exists and is not expired
     */
    exists(key: string): Promise<boolean>;

    /**
     * Set TTL on existing key (seconds).
     *
     * @param key - Key to set expiration on
     * @param seconds - TTL in seconds
     * @returns true if timeout was set, false if key doesn't exist
     */
    expire(key: string, seconds: number): Promise<boolean>;

    /**
     * Get remaining TTL (seconds).
     *
     * @param key - Key to check
     * @returns TTL in seconds, -1 if no TTL, -2 if key doesn't exist
     */
    ttl(key: string): Promise<number>;

    /**
     * Increment integer value.
     *
     * Creates key with value 1 if doesn't exist.
     * Errors if value is not an integer string.
     *
     * @param key - Key to increment
     * @returns New value after increment
     */
    incr(key: string): Promise<number>;

    /**
     * Increment by specific amount.
     *
     * Creates key with value `increment` if doesn't exist.
     * Errors if value is not an integer string.
     *
     * @param key - Key to increment
     * @param increment - Amount to add (can be negative)
     * @returns New value after increment
     */
    incrby(key: string, increment: number): Promise<number>;

    /**
     * Decrement integer value.
     *
     * Creates key with value -1 if doesn't exist.
     * Errors if value is not an integer string.
     *
     * @param key - Key to decrement
     * @returns New value after decrement
     */
    decr(key: string): Promise<number>;

    /**
     * Get multiple keys at once.
     *
     * @param keys - Keys to retrieve
     * @returns Array of values (null for missing/expired keys)
     */
    mget(...keys: string[]): Promise<(string | null)[]>;

    /**
     * Set multiple keys at once.
     *
     * @param entries - Key-value pairs to set
     */
    mset(entries: Record<string, string>): Promise<void>;

    /**
     * Set if not exists (atomic).
     *
     * @param key - Key to set
     * @param value - Value to store
     * @returns true if key was set, false if already existed
     */
    setnx(key: string, value: string): Promise<boolean>;

    // =========================================================================
    // PUBSUB - Messaging Operations
    // =========================================================================

    /**
     * Subscribe to topic patterns.
     *
     * Pattern syntax:
     * - `event.*` matches `event.chat` but not `event.chat.room`
     * - `event.**` matches `event.chat.room.123`
     *
     * @param patterns - Topic patterns to subscribe to
     * @returns Subscription handle
     */
    subscribe(patterns: string[]): Promise<PubsubSubscription>;

    /**
     * Publish message to topic.
     *
     * Payload is JSON-serialized for transmission.
     *
     * @param topic - Exact topic to publish to (no wildcards)
     * @param payload - Message payload (will be JSON-serialized)
     * @returns Number of subscribers that received the message
     */
    publish(topic: string, payload: unknown): Promise<number>;

    /**
     * Get subscriber count for a pattern.
     *
     * Returns count of subscriptions to this exact pattern.
     * Matches Redis PUBSUB NUMSUB semantics: does not count pattern
     * subscribers that would match a topic, only exact pattern matches.
     *
     * @param pattern - Exact pattern to count
     * @returns Number of subscriptions to this pattern
     */
    subscriberCount(pattern: string): Promise<number>;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Shutdown device, close connections.
     *
     * For memory backend: closes all subscriptions, clears cache
     * For Redis backend: closes all connections
     *
     * After shutdown, the device should not be used.
     */
    shutdown(): Promise<void>;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Redis device configuration.
 *
 * Embedded in HALConfig.redis to configure the Redis device.
 */
export interface RedisConfig {
    /**
     * Backend type.
     * - 'memory': In-process cache + pub/sub (default)
     * - 'redis': External Redis server
     */
    type: 'memory' | 'redis';

    /**
     * Redis connection URL (required if type: 'redis')
     *
     * Format: redis://[[username:]password@]host[:port][/database]
     */
    url?: string;

    /**
     * Key prefix for all operations.
     *
     * Useful for multi-tenant or namespacing. Applied automatically
     * to all keys and pub/sub topics.
     *
     * Default: 'monk:'
     */
    prefix?: string;

    /**
     * Default TTL for cache entries (seconds).
     *
     * 0 = no expiration (default).
     * Applied to set() calls without explicit TTL.
     */
    defaultTTL?: number;
}
